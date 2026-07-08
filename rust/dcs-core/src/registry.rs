use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::model::{
    AppConfig, ColorStrategy, DiscoveredSession, ManagedSession, RestoreOnLogin, TabSpec,
    WindowGrouping, WindowSpec, Workspace, WorkspaceDiff, WorkspaceDiffEntry, WorkspaceExport,
    WorkspaceSource,
};

const WORKSPACE_EXPORT_KIND: &str = "durable-copilot-sessions/workspaces";
const WORKSPACE_EXPORT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryDirs {
    pub managed_dir: PathBuf,
    pub workspaces_dir: PathBuf,
    pub snapshots_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Registry {
    dirs: RegistryDirs,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedSessionPatch {
    pub session_id: String,
    pub title: Option<String>,
    pub color: Option<String>,
    pub group: Option<String>,
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub tags: Option<Vec<String>>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateWorkspaceInput {
    pub name: String,
    pub description: Option<String>,
    pub source: WorkspaceSource,
    pub windows: Vec<WindowSpec>,
}

#[derive(Debug)]
pub enum RegistryError {
    Io(io::Error),
    Json(serde_json::Error),
    InvalidId(String),
    InvalidExport(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::InvalidId(id) => write!(formatter, "Invalid id: {id:?}"),
            Self::InvalidExport(message) => {
                write!(formatter, "Invalid workspace export: {message}")
            }
        }
    }
}

impl Error for RegistryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::InvalidId(_) | Self::InvalidExport(_) => None,
        }
    }
}

impl From<io::Error> for RegistryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for RegistryError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub fn default_config() -> AppConfig {
    AppConfig {
        api_port: 4517,
        web_port: 4516,
        snapshot_interval_minutes: 5,
        max_auto_snapshots: 50,
        color_strategy: ColorStrategy::ByRepo,
        auto_open_browser: true,
        window_grouping: WindowGrouping::ByRepo,
        copilot_command: "copilot".into(),
        copilot_args: Vec::new(),
        restore_on_login: RestoreOnLogin::Prompt,
    }
}

pub fn load_config(path: impl AsRef<Path>) -> AppConfig {
    let default = default_config();
    let Ok(raw) = fs::read_to_string(path) else {
        return default;
    };
    let Ok(Value::Object(persisted)) = serde_json::from_str::<Value>(&raw) else {
        return default;
    };
    let Ok(Value::Object(mut merged)) = serde_json::to_value(&default) else {
        return default;
    };
    for (key, value) in persisted {
        merged.insert(key, value);
    }
    serde_json::from_value(Value::Object(merged)).unwrap_or(default)
}

pub fn save_config(path: impl AsRef<Path>, config: &AppConfig) -> Result<(), RegistryError> {
    write_json_atomic(path.as_ref(), config)?;
    Ok(())
}

impl Registry {
    pub fn new(dirs: RegistryDirs) -> Result<Self, RegistryError> {
        for dir in [&dirs.managed_dir, &dirs.workspaces_dir, &dirs.snapshots_dir] {
            fs::create_dir_all(dir)?;
        }
        Ok(Self { dirs })
    }

    pub fn get_managed(&self, session_id: &str) -> Option<ManagedSession> {
        if !is_safe_id(session_id) {
            return None;
        }
        read_json(self.managed_file(session_id))
    }

    pub fn list_managed(&self) -> Vec<ManagedSession> {
        list_json_files(&self.dirs.managed_dir)
            .into_iter()
            .filter_map(read_json)
            .filter(|record: &ManagedSession| !record.session_id.is_empty())
            .collect()
    }

    pub fn upsert_managed(
        &self,
        patch: ManagedSessionPatch,
    ) -> Result<ManagedSession, RegistryError> {
        assert_safe_id(&patch.session_id)?;
        let existing = self.get_managed(&patch.session_id);
        let merged = ManagedSession {
            session_id: patch.session_id,
            title: patch
                .title
                .or_else(|| existing.as_ref().and_then(|item| item.title.clone())),
            color: patch
                .color
                .or_else(|| existing.as_ref().and_then(|item| item.color.clone())),
            group: patch
                .group
                .or_else(|| existing.as_ref().and_then(|item| item.group.clone())),
            pinned: patch
                .pinned
                .or_else(|| existing.as_ref().and_then(|item| item.pinned)),
            hidden: patch
                .hidden
                .or_else(|| existing.as_ref().and_then(|item| item.hidden)),
            tags: patch
                .tags
                .or_else(|| existing.as_ref().and_then(|item| item.tags.clone())),
            archived: patch
                .archived
                .or_else(|| existing.as_ref().and_then(|item| item.archived)),
            updated_at: now_iso(),
        };
        write_json_atomic(&self.managed_file(&merged.session_id), &merged)?;
        Ok(merged)
    }

    pub fn delete_managed(&self, session_id: &str) -> Result<(), RegistryError> {
        if !is_safe_id(session_id) {
            return Ok(());
        }
        remove_file_if_exists(self.managed_file(session_id))?;
        Ok(())
    }

    pub fn get_workspace(&self, id: &str) -> Option<Workspace> {
        if !is_safe_id(id) {
            return None;
        }
        read_json(self.workspace_file(id))
    }

    pub fn list_workspaces(&self) -> Vec<Workspace> {
        let mut workspaces: Vec<Workspace> = list_json_files(&self.dirs.workspaces_dir)
            .into_iter()
            .filter_map(read_json)
            .filter(|record: &Workspace| !record.id.is_empty())
            .collect();
        workspaces.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        workspaces
    }

    pub fn find_workspace_by_name(&self, name: &str) -> Option<Workspace> {
        self.list_workspaces()
            .into_iter()
            .find(|workspace| workspace.name == name)
    }

    pub fn create_workspace(
        &self,
        input: CreateWorkspaceInput,
    ) -> Result<Workspace, RegistryError> {
        let timestamp = now_iso();
        let workspace = Workspace {
            id: Uuid::new_v4().to_string(),
            name: input.name,
            description: input.description,
            source: input.source,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            windows: input.windows,
        };
        write_json_atomic(&self.workspace_file(&workspace.id), &workspace)?;
        Ok(workspace)
    }

    pub fn save_workspace(&self, workspace: Workspace) -> Result<Workspace, RegistryError> {
        assert_safe_id(&workspace.id)?;
        let saved = Workspace {
            updated_at: now_iso(),
            ..workspace
        };
        write_json_atomic(&self.workspace_file(&saved.id), &saved)?;
        Ok(saved)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<(), RegistryError> {
        if !is_safe_id(id) {
            return Ok(());
        }
        remove_file_if_exists(self.workspace_file(id))?;
        Ok(())
    }

    pub fn add_snapshot(
        &self,
        workspace: &Workspace,
        retain: usize,
    ) -> Result<Workspace, RegistryError> {
        let file_name = format!(
            "{}-{}.json",
            snapshot_stamp(&workspace.created_at),
            workspace.id
        );
        write_json_atomic(&self.dirs.snapshots_dir.join(file_name), workspace)?;
        self.prune_snapshots(retain)?;
        Ok(workspace.clone())
    }

    pub fn list_snapshots(&self) -> Vec<Workspace> {
        snapshot_files_newest_first(&self.dirs.snapshots_dir)
            .into_iter()
            .filter_map(read_json)
            .filter(|record: &Workspace| !record.id.is_empty())
            .collect()
    }

    pub fn latest_snapshot(&self) -> Option<Workspace> {
        snapshot_files_newest_first(&self.dirs.snapshots_dir)
            .into_iter()
            .find_map(read_json)
    }

    fn prune_snapshots(&self, retain: usize) -> Result<(), RegistryError> {
        for file in snapshot_files_newest_first(&self.dirs.snapshots_dir)
            .into_iter()
            .skip(retain)
        {
            remove_file_if_exists(file)?;
        }
        Ok(())
    }

    fn managed_file(&self, session_id: &str) -> PathBuf {
        self.dirs.managed_dir.join(format!("{session_id}.json"))
    }

    fn workspace_file(&self, id: &str) -> PathBuf {
        self.dirs.workspaces_dir.join(format!("{id}.json"))
    }
}

pub fn export_workspaces(
    workspaces: Vec<Workspace>,
    exported_at: String,
) -> Result<String, RegistryError> {
    let envelope = WorkspaceExport {
        kind: WORKSPACE_EXPORT_KIND.into(),
        version: WORKSPACE_EXPORT_VERSION,
        exported_at,
        workspaces,
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

pub fn parse_workspace_export(json: &str) -> Result<Vec<Workspace>, RegistryError> {
    let envelope = serde_json::from_str::<WorkspaceExport>(json)?;
    if envelope.kind != WORKSPACE_EXPORT_KIND {
        return Err(RegistryError::InvalidExport(format!(
            "expected kind {WORKSPACE_EXPORT_KIND:?}, got {:?}",
            envelope.kind
        )));
    }
    if envelope.version != WORKSPACE_EXPORT_VERSION {
        return Err(RegistryError::InvalidExport(format!(
            "unsupported version {}",
            envelope.version
        )));
    }
    Ok(envelope.workspaces)
}

pub fn diff_workspace(workspace: &Workspace, live: &[DiscoveredSession]) -> WorkspaceDiff {
    let mut diff = WorkspaceDiff {
        missing: Vec::new(),
        stale_cwd: Vec::new(),
        changed: Vec::new(),
        added_live: Vec::new(),
        unchanged: 0,
    };
    let mut referenced_ids = Vec::new();

    for tab in flatten_tabs(workspace) {
        referenced_ids.push(tab.session_id.clone());
        let Some(match_session) = live.iter().find(|session| session.id == tab.session_id) else {
            diff.missing.push(WorkspaceDiffEntry {
                session_id: tab.session_id.clone(),
                title: tab.title.clone(),
                detail: "session no longer discovered".into(),
            });
            continue;
        };

        if !match_session.cwd_exists {
            diff.stale_cwd.push(WorkspaceDiffEntry {
                session_id: tab.session_id.clone(),
                title: tab.title.clone(),
                detail: format!("cwd no longer exists: {}", match_session.cwd),
            });
            continue;
        }

        if normalize_cwd(&tab.cwd) != normalize_cwd(&match_session.cwd) {
            diff.stale_cwd.push(WorkspaceDiffEntry {
                session_id: tab.session_id.clone(),
                title: tab.title.clone(),
                detail: format!("cwd changed: {:?} -> {:?}", tab.cwd, match_session.cwd),
            });
            continue;
        }

        if tab_implies_branch_change(tab, match_session) {
            diff.changed.push(WorkspaceDiffEntry {
                session_id: tab.session_id.clone(),
                title: tab.title.clone(),
                detail: format!(
                    "branch is now {:?}",
                    match_session.branch.as_deref().unwrap_or_default()
                ),
            });
            continue;
        }

        diff.unchanged += 1;
    }

    for session in live {
        if !referenced_ids.iter().any(|id| id == &session.id) {
            diff.added_live.push(WorkspaceDiffEntry {
                session_id: session.id.clone(),
                title: session.name.clone().unwrap_or_else(|| session.id.clone()),
                detail: "live but not in workspace".into(),
            });
        }
    }

    diff
}

pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn assert_safe_id(id: &str) -> Result<(), RegistryError> {
    if is_safe_id(id) {
        Ok(())
    } else {
        Err(RegistryError::InvalidId(id.to_owned()))
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 formatting should not fail")
}

fn read_json<T: DeserializeOwned>(file: impl AsRef<Path>) -> Option<T> {
    let raw = fs::read_to_string(file).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json_atomic<T: Serialize>(file: &Path, data: &T) -> Result<(), RegistryError> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = file.with_extension(format!("{}.{}.tmp", std::process::id(), Uuid::new_v4()));
    let raw = serde_json::to_string_pretty(data)?;
    fs::write(&tmp, raw)?;
    match fs::rename(&tmp, file) {
        Ok(()) => Ok(()),
        Err(_) if file.exists() => {
            fs::remove_file(file)?;
            fs::rename(&tmp, file).map_err(RegistryError::Io)
        }
        Err(error) => Err(RegistryError::Io(error)),
    }?;
    remove_file_if_exists(tmp)?;
    Ok(())
}

fn remove_file_if_exists(path: impl AsRef<Path>) -> Result<(), RegistryError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RegistryError::Io(error)),
    }
}

fn list_json_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect()
}

fn snapshot_stamp(iso: &str) -> String {
    iso.replace([':', '.'], "-")
}

fn snapshot_files_newest_first(dir: &Path) -> Vec<PathBuf> {
    let mut files = list_json_files(dir);
    files.sort_by(|a, b| {
        b.file_name()
            .and_then(|name| name.to_str())
            .cmp(&a.file_name().and_then(|name| name.to_str()))
    });
    files
}

fn flatten_tabs(workspace: &Workspace) -> impl Iterator<Item = &TabSpec> {
    workspace
        .windows
        .iter()
        .flat_map(|window| window.tabs.iter())
}

fn normalize_cwd(cwd: &str) -> String {
    cwd.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn tab_implies_branch_change(tab: &TabSpec, live: &DiscoveredSession) -> bool {
    let Some(branch) = live.branch.as_deref() else {
        return false;
    };
    if !tab.title.contains('@') && !tab.title.contains('#') {
        return false;
    }
    !tab.title
        .to_ascii_lowercase()
        .contains(&branch.to_ascii_lowercase())
}
