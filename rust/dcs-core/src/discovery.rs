use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::model::{DiscoveredSession, SessionLiveness, WorkspaceYaml};

const CLI_CLIENT_NAME: &str = "github/cli";

pub type ProcessSnapshot = BTreeMap<u32, String>;

#[derive(Debug, Clone)]
pub struct DiscoveryOptions {
    pub session_state_dir: PathBuf,
    pub process_snapshot: ProcessSnapshot,
    pub live_only: bool,
}

impl DiscoveryOptions {
    pub fn new(session_state_dir: impl Into<PathBuf>) -> Self {
        Self {
            session_state_dir: session_state_dir.into(),
            process_snapshot: ProcessSnapshot::new(),
            live_only: false,
        }
    }
}

pub fn get_process_snapshot() -> ProcessSnapshot {
    let mut snapshot = ProcessSnapshot::new();
    for image in ["copilot.exe", "node.exe"] {
        let Ok(output) = Command::new("tasklist")
            .args(["/fi", &format!("imagename eq {image}"), "/fo", "csv", "/nh"])
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Some((name, pid)) = parse_tasklist_csv_line(line) {
                snapshot.insert(pid, name.to_ascii_lowercase());
            }
        }
    }
    snapshot
}

pub fn list_sessions(options: &DiscoveryOptions) -> Vec<DiscoveredSession> {
    let Ok(entries) = fs::read_dir(&options.session_state_dir) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if let Some(session) = read_session(
            &options.session_state_dir,
            &id,
            &options.process_snapshot,
            options.live_only,
        ) {
            sessions.push(session);
        }
    }

    sort_sessions(&mut sessions);
    sessions
}

pub fn get_session(options: &DiscoveryOptions, id: &str) -> Option<DiscoveredSession> {
    let session = read_session(
        &options.session_state_dir,
        id,
        &options.process_snapshot,
        false,
    )?;
    Some(session)
}

fn read_session(
    session_state_dir: &Path,
    id: &str,
    snapshot: &ProcessSnapshot,
    live_only: bool,
) -> Option<DiscoveredSession> {
    let session_dir = session_state_dir.join(id);
    let liveness = read_liveness(&session_dir, snapshot);
    if live_only && liveness.live_pids.is_empty() {
        return None;
    }

    let raw = fs::read_to_string(session_dir.join("workspace.yaml")).ok()?;
    let workspace = serde_yaml::from_str::<WorkspaceYaml>(&raw).ok()?;
    let cwd = workspace.cwd;
    let client_name = workspace.client_name;
    let session_liveness = if !liveness.live_pids.is_empty() {
        SessionLiveness::Live
    } else if liveness.lock_count > 0 {
        SessionLiveness::Stale
    } else {
        SessionLiveness::Inactive
    };
    let top_level = match client_name.as_deref() {
        Some(name) => name == CLI_CLIENT_NAME,
        None => true,
    };

    Some(DiscoveredSession {
        id: id.to_owned(),
        cwd_exists: !cwd.is_empty() && Path::new(&cwd).exists(),
        cwd,
        name: workspace.name,
        summary: None,
        git_root: workspace.git_root,
        repository: workspace.repository,
        branch: workspace.branch,
        client_name,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
        liveness: session_liveness,
        live_pids: liveness.live_pids,
        top_level,
        branch_of: workspace.branch_of,
        branch_note: workspace.branch_note,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Liveness {
    live_pids: Vec<u32>,
    lock_count: usize,
}

fn read_liveness(session_dir: &Path, snapshot: &ProcessSnapshot) -> Liveness {
    let Ok(entries) = fs::read_dir(session_dir) else {
        return Liveness {
            live_pids: Vec::new(),
            lock_count: 0,
        };
    };

    let mut lock_count = 0;
    let mut live = BTreeSet::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = lock_pid(&file_name) else {
            continue;
        };
        lock_count += 1;
        if pid_is_live_copilot(pid, snapshot) {
            live.insert(pid);
        }
    }

    Liveness {
        live_pids: live.into_iter().collect(),
        lock_count,
    }
}

fn pid_is_live_copilot(pid: u32, snapshot: &ProcessSnapshot) -> bool {
    if snapshot.is_empty() {
        return false;
    }
    let Some(name) = snapshot.get(&pid) else {
        return false;
    };
    name.contains("copilot") || name.contains("node")
}

fn lock_pid(file_name: &str) -> Option<u32> {
    let pid = file_name
        .strip_prefix("inuse.")?
        .strip_suffix(".lock")?
        .parse::<u32>()
        .ok()?;
    (pid > 0).then_some(pid)
}

fn parse_tasklist_csv_line(line: &str) -> Option<(String, u32)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('"') {
        return None;
    }
    let mut parts = trimmed.split("\",\"");
    let name = parts.next()?.trim_start_matches('"').to_owned();
    let pid = parts.next()?.parse::<u32>().ok()?;
    Some((name, pid))
}

fn sort_sessions(sessions: &mut [DiscoveredSession]) {
    sessions.sort_by(|a, b| {
        let a_live = matches!(a.liveness, SessionLiveness::Live);
        let b_live = matches!(b.liveness, SessionLiveness::Live);
        b_live
            .cmp(&a_live)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
}
