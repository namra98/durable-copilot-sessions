use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::branch::branch_session;
use crate::discovery::{get_process_snapshot, list_sessions, DiscoveryOptions, ProcessSnapshot};
use crate::graph::{annotate_open, build_graph, build_windows, OpenAnnotation};
use crate::launch::{
    execute_launch_plan, plan_launch_windows, plan_new_session, plan_resume_session, LaunchPlan,
    LaunchWindowsOptions, NewSessionOptions,
};
use crate::logs::tail_logs;
use crate::memory::SqliteMemoryStore;
use crate::model::{
    AppConfig, CleanStaleBody, CreateWorkspaceBody, DiscoveredSession, ForkBody, ForkResult,
    GraphModel, ImportWorkspacesBody, LaunchResult, LogRecord, ManagedSession, Memory,
    MemoryRecallPack, MemorySearchHit, MemorySearchParams, NewSessionBody, ResumeBatchBody,
    ResumeBody, ResumeOptions, SessionDetail, SessionFilter, SessionListResult, SessionLiveness,
    SessionPatch, SessionRole, StatsReport, WindowTarget, Workspace, WorkspaceDiff,
    WorkspaceSource,
};
use crate::paths::DcsPaths;
use crate::registry::{
    diff_workspace, export_workspaces, load_config, parse_workspace_export, save_config,
    CreateWorkspaceInput, ManagedSessionPatch, Registry, RegistryDirs,
};
use crate::stats::compute_stats;
use crate::transcript::export_transcript;

#[derive(Debug)]
pub enum ManagerError {
    Io(std::io::Error),
    Registry(crate::registry::RegistryError),
    Launch(crate::launch::LaunchError),
    Memory(crate::memory::MemoryError),
    Branch(crate::branch::BranchError),
    MissingSession(String),
    MissingWorkspace(String),
    InvalidInput(String),
}

impl fmt::Display for ManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Registry(error) => write!(formatter, "{error}"),
            Self::Launch(error) => write!(formatter, "{error}"),
            Self::Memory(error) => write!(formatter, "{error}"),
            Self::Branch(error) => write!(formatter, "{error}"),
            Self::MissingSession(id) => write!(formatter, "Session not found: {id}"),
            Self::MissingWorkspace(id) => write!(formatter, "Workspace not found: {id}"),
            Self::InvalidInput(message) => write!(formatter, "{message}"),
        }
    }
}

impl Error for ManagerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Registry(error) => Some(error),
            Self::Launch(error) => Some(error),
            Self::Memory(error) => Some(error),
            Self::Branch(error) => Some(error),
            Self::MissingSession(_) | Self::MissingWorkspace(_) | Self::InvalidInput(_) => None,
        }
    }
}

impl From<std::io::Error> for ManagerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<crate::registry::RegistryError> for ManagerError {
    fn from(error: crate::registry::RegistryError) -> Self {
        Self::Registry(error)
    }
}

impl From<crate::launch::LaunchError> for ManagerError {
    fn from(error: crate::launch::LaunchError) -> Self {
        Self::Launch(error)
    }
}

impl From<crate::memory::MemoryError> for ManagerError {
    fn from(error: crate::memory::MemoryError) -> Self {
        Self::Memory(error)
    }
}

impl From<crate::branch::BranchError> for ManagerError {
    fn from(error: crate::branch::BranchError) -> Self {
        Self::Branch(error)
    }
}

pub struct SessionManager {
    paths: DcsPaths,
    registry: Registry,
    config: AppConfig,
    memory_store: SqliteMemoryStore,
    process_snapshot: Option<ProcessSnapshot>,
}

impl SessionManager {
    pub fn new(paths: DcsPaths) -> Result<Self, ManagerError> {
        paths.ensure_owned_dirs()?;
        let config = load_config(&paths.config_file);
        let registry = Registry::new(RegistryDirs {
            managed_dir: paths.managed_sessions_dir.clone(),
            workspaces_dir: paths.workspaces_dir.clone(),
            snapshots_dir: paths.snapshots_dir.clone(),
        })?;
        let memory_store = SqliteMemoryStore::open(&paths.memory_db)?;
        Ok(Self {
            paths,
            registry,
            config,
            memory_store,
            process_snapshot: None,
        })
    }

    pub fn with_process_snapshot_for_tests(
        paths: DcsPaths,
        process_snapshot: ProcessSnapshot,
    ) -> Result<Self, ManagerError> {
        let mut manager = Self::new(paths)?;
        manager.process_snapshot = Some(process_snapshot);
        Ok(manager)
    }

    pub fn paths(&self) -> &DcsPaths {
        &self.paths
    }

    pub fn config(&self) -> AppConfig {
        self.config.clone()
    }

    pub fn update_config(&mut self, patch: serde_json::Value) -> Result<AppConfig, ManagerError> {
        let serde_json::Value::Object(patch) = patch else {
            return Err(ManagerError::InvalidInput(
                "Config update body must be a JSON object.".into(),
            ));
        };
        let serde_json::Value::Object(mut merged) = serde_json::to_value(&self.config)
            .map_err(|error| ManagerError::InvalidInput(error.to_string()))?
        else {
            return Err(ManagerError::InvalidInput(
                "Could not serialize current config.".into(),
            ));
        };
        for (key, value) in patch {
            merged.insert(key, value);
        }
        let next = serde_json::from_value::<AppConfig>(serde_json::Value::Object(merged))
            .map_err(|error| ManagerError::InvalidInput(error.to_string()))?;
        save_config(&self.paths.config_file, &next)?;
        self.config = next.clone();
        Ok(next)
    }

    pub fn list_sessions(&self, filter: SessionFilter) -> SessionListResult {
        let discovered = self.discovered_sessions(if matches!(filter, SessionFilter::All) {
            SessionFilter::All
        } else {
            SessionFilter::Live
        });
        let annotation = annotate_open(&discovered);
        let selected = match filter {
            SessionFilter::Open => discovered
                .into_iter()
                .filter(|session| {
                    annotation.role_by_id.get(&session.id) == Some(&SessionRole::Primary)
                })
                .collect(),
            SessionFilter::Live | SessionFilter::All => discovered,
        };
        let managed = self.managed_by_id();
        views_from(selected, &managed, &self.config, &annotation)
    }

    pub fn get_session(&self, id: &str) -> Result<SessionDetail, ManagerError> {
        let discovered = self.all_discovered_sessions();
        let managed = self.managed_by_id();
        let annotation = annotate_open(&discovered);
        let views = views_from(discovered, &managed, &self.config, &annotation).sessions;
        let Some(session) = views.iter().find(|session| session.id == id).cloned() else {
            return Err(ManagerError::MissingSession(id.into()));
        };
        let children = views
            .into_iter()
            .filter(|candidate| candidate.branch_of.as_deref() == Some(id))
            .collect();
        Ok(SessionDetail { session, children })
    }

    pub fn update_session(
        &self,
        id: &str,
        patch: SessionPatch,
    ) -> Result<ManagedSession, ManagerError> {
        let managed = self.registry.upsert_managed(ManagedSessionPatch {
            session_id: id.into(),
            title: patch.title,
            color: patch.color,
            group: patch.group,
            pinned: patch.pinned,
            hidden: patch.hidden,
            tags: patch.tags,
            archived: patch.archived,
        })?;
        Ok(managed)
    }

    pub fn resume_session(
        &self,
        id: &str,
        body: ResumeBody,
        dry_run: bool,
    ) -> Result<LaunchResult, ManagerError> {
        let detail = self.get_session(id)?.session;
        let managed = self.registry.get_managed(id);
        let plan = plan_resume_session(
            &ResumeOptions {
                session_id: id.into(),
                title: body
                    .title
                    .or_else(|| managed.as_ref().and_then(|managed| managed.title.clone()))
                    .or_else(|| detail.name.clone()),
                color: body
                    .color
                    .or_else(|| managed.as_ref().and_then(|managed| managed.color.clone())),
                cwd: body.cwd.or(Some(detail.cwd)),
                fallbacks: Some(vec![self.home_dir_string()]),
                window: body.window.or(Some(WindowTarget::New)),
                copilot_args: Some(self.config.copilot_args.clone()),
                copilot_command: Some(self.config.copilot_command.clone()),
                dry_run: Some(dry_run),
            },
            &self.paths.launch_scripts_dir,
            self.home_dir(),
        )?;
        Ok(execute_launch_plan(plan, dry_run))
    }

    pub fn resume_batch(
        &self,
        body: ResumeBatchBody,
        dry_run: bool,
    ) -> Result<LaunchResult, ManagerError> {
        let managed = self.managed_by_id();
        let sessions = self
            .all_discovered_sessions()
            .into_iter()
            .filter(|session| body.session_ids.iter().any(|id| id == &session.id))
            .collect::<Vec<_>>();
        let windows = vec![crate::model::WindowSpec {
            id: "resume-batch".into(),
            label: None,
            tabs: sessions
                .iter()
                .map(|session| {
                    crate::graph::tab_for(session, managed.get(&session.id), &self.config)
                })
                .collect(),
        }];
        let plan = self.plan_windows(&windows, body.window, dry_run)?;
        Ok(plan.result)
    }

    pub fn list_workspaces(&self) -> Vec<Workspace> {
        self.registry.list_workspaces()
    }

    pub fn get_workspace(&self, id: &str) -> Result<Workspace, ManagerError> {
        self.registry
            .get_workspace(id)
            .ok_or_else(|| ManagerError::MissingWorkspace(id.into()))
    }

    pub fn create_workspace(&self, body: CreateWorkspaceBody) -> Result<Workspace, ManagerError> {
        if body.name.trim().is_empty() {
            return Err(ManagerError::InvalidInput(
                "Workspace name is required.".into(),
            ));
        }
        let windows = match (body.from_live.unwrap_or(false), body.windows) {
            (true, _) => {
                let filter = body.filter.unwrap_or(SessionFilter::Open);
                let discovered = self.discovered_sessions(filter);
                build_windows(&discovered, &self.managed_by_id(), &self.config)
            }
            (false, Some(windows)) => windows,
            (false, None) => Vec::new(),
        };
        self.registry
            .create_workspace(CreateWorkspaceInput {
                name: body.name,
                description: body.description,
                source: WorkspaceSource::Manual,
                windows,
            })
            .map_err(ManagerError::from)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<(), ManagerError> {
        self.registry.delete_workspace(id)?;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Workspace, ManagerError> {
        let workspace = Workspace {
            id: Uuid::new_v4().to_string(),
            name: "Auto snapshot".into(),
            description: None,
            source: WorkspaceSource::AutoSnapshot,
            created_at: now_iso(),
            updated_at: now_iso(),
            windows: build_windows(
                &self.discovered_sessions(SessionFilter::Open),
                &self.managed_by_id(),
                &self.config,
            ),
        };
        self.registry
            .add_snapshot(&workspace, self.config.max_auto_snapshots as usize)
            .map_err(ManagerError::from)
    }

    pub fn latest_snapshot(&self) -> Result<Workspace, ManagerError> {
        self.registry
            .latest_snapshot()
            .ok_or_else(|| ManagerError::MissingWorkspace("latest snapshot".into()))
    }

    pub fn list_snapshots(&self) -> Vec<Workspace> {
        self.registry.list_snapshots()
    }

    pub fn restore_workspace(
        &self,
        id: &str,
        window: Option<WindowTarget>,
        dry_run: bool,
    ) -> Result<LaunchResult, ManagerError> {
        let workspace = self.get_workspace(id)?;
        let plan = self.plan_windows(&workspace.windows, window, dry_run)?;
        Ok(plan.result)
    }

    pub fn restore_latest_snapshot(
        &self,
        window: Option<WindowTarget>,
        dry_run: bool,
    ) -> Result<LaunchResult, ManagerError> {
        let workspace = self.latest_snapshot()?;
        let plan = self.plan_windows(&workspace.windows, window, dry_run)?;
        Ok(plan.result)
    }

    pub fn workspace_diff(&self, id: &str) -> Result<WorkspaceDiff, ManagerError> {
        let workspace = self.get_workspace(id)?;
        Ok(diff_workspace(
            &workspace,
            &self.discovered_sessions(SessionFilter::All),
        ))
    }

    pub fn export_workspaces(&self) -> Result<String, ManagerError> {
        Ok(export_workspaces(
            self.registry.list_workspaces(),
            now_iso(),
        )?)
    }

    pub fn import_workspaces(
        &self,
        body: ImportWorkspacesBody,
    ) -> Result<Vec<Workspace>, ManagerError> {
        let mut imported = parse_workspace_export(&body.json)?;
        if body.fresh_ids.unwrap_or(false) {
            for workspace in &mut imported {
                workspace.id = Uuid::new_v4().to_string();
                workspace.source = WorkspaceSource::Imported;
            }
        }
        let mut saved = Vec::new();
        for mut workspace in imported {
            workspace.source = WorkspaceSource::Imported;
            saved.push(self.registry.save_workspace(workspace)?);
        }
        Ok(saved)
    }

    pub fn promote_snapshot(&self, name: String) -> Result<Workspace, ManagerError> {
        if name.trim().is_empty() {
            return Err(ManagerError::InvalidInput(
                "Workspace name is required.".into(),
            ));
        }
        let mut snapshot = self.latest_snapshot()?;
        snapshot.id = Uuid::new_v4().to_string();
        snapshot.name = name;
        snapshot.source = WorkspaceSource::Manual;
        self.registry
            .save_workspace(snapshot)
            .map_err(ManagerError::from)
    }

    pub fn graph(&self, filter: SessionFilter) -> GraphModel {
        let discovered = self.discovered_sessions(filter);
        build_graph(&discovered, &self.managed_by_id(), &self.config)
    }

    pub fn stats(&self) -> StatsReport {
        compute_stats(&self.paths.copilot_session_store_db)
    }

    pub fn reindex_memory(&mut self) -> Result<u32, ManagerError> {
        Ok(self
            .memory_store
            .reindex(&self.paths.copilot_session_store_db)?)
    }

    pub fn memory_count(&self) -> u32 {
        self.memory_store.count()
    }

    pub fn search_memory(&self, params: MemorySearchParams) -> Vec<MemorySearchHit> {
        self.memory_store.search(
            &params.q,
            params.repository.as_deref(),
            params.kind,
            params.limit,
        )
    }

    pub fn related_memory(&self, session_id: &str, limit: Option<u32>) -> Vec<Memory> {
        self.memory_store.related(session_id, limit)
    }

    pub fn recall_memory(
        &self,
        repository: Option<&str>,
        branch: Option<&str>,
        limit: Option<u32>,
    ) -> MemoryRecallPack {
        self.memory_store.recall(repository, branch, limit)
    }

    pub fn memories_for_session(&self, session_id: &str) -> Vec<Memory> {
        self.memory_store.list_for_session(session_id)
    }

    pub fn tail_logs(&self, lines: Option<usize>, level: Option<&str>) -> Vec<LogRecord> {
        tail_logs(&self.paths.logs_dir, lines, level)
    }

    pub fn transcript(&self, session_id: &str) -> String {
        export_transcript(&self.paths.copilot_session_state_dir, session_id)
    }

    pub fn clean_stale(&self, body: CleanStaleBody) -> serde_json::Value {
        let stale = self
            .all_discovered_sessions()
            .into_iter()
            .filter(|session| matches!(session.liveness, SessionLiveness::Stale))
            .collect::<Vec<_>>();
        let mut removed = 0u32;
        if body.remove.unwrap_or(false) {
            for session in &stale {
                removed += remove_lock_files(&self.paths.copilot_session_state_dir, &session.id);
            }
        }
        serde_json::json!({ "stale": stale.len(), "removed": removed })
    }

    pub fn new_session(
        &self,
        body: NewSessionBody,
        dry_run: bool,
    ) -> Result<LaunchResult, ManagerError> {
        if body.title.trim().is_empty() {
            return Err(ManagerError::InvalidInput(
                "Session title is required.".into(),
            ));
        }
        let plan = plan_new_session(
            &NewSessionOptions {
                title: body.title,
                cwd: body.cwd,
                color: body.color.unwrap_or_else(|| "blue".into()),
                prompt: body.prompt,
                window: body.window,
                copilot_command: Some(self.config.copilot_command.clone()),
                copilot_args: self.config.copilot_args.clone(),
            },
            &self.paths.launch_scripts_dir,
            self.home_dir(),
        )?;
        Ok(execute_launch_plan(plan, dry_run))
    }

    pub fn fork_session(
        &self,
        id: &str,
        body: ForkBody,
        dry_run: bool,
    ) -> Result<ForkResult, ManagerError> {
        let fork = branch_session(
            &self.paths.copilot_session_state_dir,
            id,
            body.note.as_deref(),
            None,
        )?;
        let session = self.get_session(&fork.new_session_id)?.session;
        let launch = if body.launch.unwrap_or(false) {
            Some(self.resume_session(
                &fork.new_session_id,
                ResumeBody {
                    window: body.window,
                    color: body.color,
                    title: Some(fork.new_session_name.clone()),
                    cwd: Some(session.cwd.clone()),
                },
                dry_run,
            )?)
        } else {
            None
        };
        Ok(ForkResult {
            session,
            fork,
            launch,
        })
    }

    fn discovered_sessions(&self, filter: SessionFilter) -> Vec<DiscoveredSession> {
        let mut options = DiscoveryOptions::new(&self.paths.copilot_session_state_dir);
        options.process_snapshot = self
            .process_snapshot
            .clone()
            .unwrap_or_else(get_process_snapshot);
        if matches!(filter, SessionFilter::Live | SessionFilter::Open) {
            options.live_only = true;
        }
        let mut sessions = list_sessions(&options);
        if matches!(filter, SessionFilter::Open) {
            let annotation = annotate_open(&sessions);
            sessions.retain(|session| {
                annotation.role_by_id.get(&session.id) != Some(&SessionRole::Child)
            });
        }
        sessions
    }

    fn all_discovered_sessions(&self) -> Vec<DiscoveredSession> {
        self.discovered_sessions(SessionFilter::All)
    }

    fn managed_by_id(&self) -> HashMap<String, ManagedSession> {
        self.registry
            .list_managed()
            .into_iter()
            .map(|managed| (managed.session_id.clone(), managed))
            .collect()
    }

    fn plan_windows(
        &self,
        windows: &[crate::model::WindowSpec],
        window: Option<WindowTarget>,
        dry_run: bool,
    ) -> Result<LaunchPlan, ManagerError> {
        let plan = plan_launch_windows(
            windows,
            &LaunchWindowsOptions {
                window,
                copilot_command: Some(self.config.copilot_command.clone()),
                copilot_args: Some(self.config.copilot_args.clone()),
                home_dir: self.home_dir(),
            },
            &self.paths.launch_scripts_dir,
        )?;
        Ok(LaunchPlan {
            result: execute_launch_plan(plan.clone(), dry_run),
            ..plan
        })
    }

    fn home_dir(&self) -> PathBuf {
        self.paths
            .state_dir
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn home_dir_string(&self) -> String {
        self.home_dir().to_string_lossy().into_owned()
    }
}

fn views_from(
    sessions: Vec<DiscoveredSession>,
    managed_by_id: &HashMap<String, ManagedSession>,
    config: &AppConfig,
    annotation: &OpenAnnotation,
) -> SessionListResult {
    let sessions = sessions
        .into_iter()
        .map(|session| {
            let managed = managed_by_id.get(&session.id);
            let computed_color = crate::graph::tab_for(&session, managed, config).color;
            let child_count = annotation
                .children_by_id
                .get(&session.id)
                .map(|ids| ids.len().min(u32::MAX as usize) as u32);
            crate::model::SessionView {
                id: session.id.clone(),
                cwd: session.cwd,
                cwd_exists: session.cwd_exists,
                name: session.name,
                summary: session.summary,
                git_root: session.git_root,
                repository: session.repository,
                branch: session.branch,
                client_name: session.client_name,
                created_at: session.created_at,
                updated_at: session.updated_at,
                liveness: session.liveness,
                live_pids: session.live_pids,
                top_level: session.top_level,
                branch_of: session.branch_of,
                branch_note: session.branch_note,
                title: managed.and_then(|managed| managed.title.clone()),
                color: managed
                    .and_then(|managed| managed.color.clone())
                    .or(Some(computed_color)),
                group: managed.and_then(|managed| managed.group.clone()),
                pinned: managed.and_then(|managed| managed.pinned),
                hidden: managed.and_then(|managed| managed.hidden),
                managed: managed.is_some(),
                tags: managed.and_then(|managed| managed.tags.clone()),
                archived: managed.and_then(|managed| managed.archived),
                role: annotation.role_by_id.get(&session.id).copied(),
                group_pid: annotation.group_pid_by_id.get(&session.id).copied(),
                child_count,
            }
        })
        .collect();
    SessionListResult {
        sessions,
        open_count: annotation.open_count,
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn remove_lock_files(session_state_dir: &Path, session_id: &str) -> u32 {
    let dir = session_state_dir.join(session_id);
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("inuse.")
            && name.ends_with(".lock")
            && fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}
