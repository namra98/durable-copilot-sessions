use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value as YamlValue};
use uuid::Uuid;

use crate::model::SessionBranchResult;

const CHECKPOINT_INDEX_HEADER: &str = "# Checkpoint History\n\nCheckpoints are listed in chronological order. Checkpoint 1 is the oldest, higher numbers are more recent.\n\n| # | Title | File |\n|---|-------|------|\n";
const REWIND_INDEX_JSON: &str = "{\"version\":1,\"snapshots\":[],\"filePathMap\":{}}\n";

#[derive(Debug)]
pub enum BranchError {
    Io(io::Error),
    Yaml(serde_yaml::Error),
    Json(serde_json::Error),
    MissingWorkspace(PathBuf),
    DestinationExists(PathBuf),
    InvalidWorkspace,
}

impl fmt::Display for BranchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Yaml(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::MissingWorkspace(path) => {
                write!(formatter, "Missing workspace metadata: {}", path.display())
            }
            Self::DestinationExists(path) => write!(
                formatter,
                "Branch destination already exists: {}",
                path.display()
            ),
            Self::InvalidWorkspace => write!(formatter, "Invalid workspace metadata"),
        }
    }
}

impl Error for BranchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Yaml(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::MissingWorkspace(_) | Self::DestinationExists(_) | Self::InvalidWorkspace => None,
        }
    }
}

impl From<io::Error> for BranchError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_yaml::Error> for BranchError {
    fn from(error: serde_yaml::Error) -> Self {
        Self::Yaml(error)
    }
}

impl From<serde_json::Error> for BranchError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub fn branch_session(
    state_dir: impl AsRef<Path>,
    parent_id: &str,
    note: Option<&str>,
    new_id: Option<&str>,
) -> Result<SessionBranchResult, BranchError> {
    let state_dir = state_dir.as_ref();
    let current_dir = state_dir.join(parent_id);
    let workspace_path = current_dir.join("workspace.yaml");
    if !workspace_path.exists() {
        return Err(BranchError::MissingWorkspace(workspace_path));
    }
    let new_id = new_id
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let new_dir = state_dir.join(&new_id);
    if new_dir.exists() {
        return Err(BranchError::DestinationExists(new_dir));
    }

    fs::create_dir_all(state_dir)?;
    let staging = state_dir.join(format!(
        ".tmp-branch-{}",
        Uuid::new_v4().to_string().replace('-', "")
    ));
    let result = (|| {
        copy_session_dir(&current_dir, &staging)?;
        let new_name =
            rewrite_workspace(&staging.join("workspace.yaml"), parent_id, &new_id, note)?;
        rewrite_session_start(&staging.join("events.jsonl"), &new_id, &new_name)?;
        reset_rewind(&staging)?;
        reset_checkpoints(&staging)?;
        rename_with_retry(&staging, &new_dir)?;
        Ok(SessionBranchResult {
            new_session_id: new_id,
            new_session_name: new_name,
            new_session_path: new_dir.to_string_lossy().into_owned(),
            parent_id: parent_id.into(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn copy_session_dir(from: &Path, to: &Path) -> Result<(), BranchError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_copy(&name) {
            continue;
        }
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_session_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn should_skip_copy(name: &str) -> bool {
    if name == "session.db" || name == "session.db-shm" || name == "session.db-wal" {
        return true;
    }
    name.starts_with("inuse.") && name.ends_with(".lock")
}

fn rewrite_workspace(
    workspace_path: &Path,
    parent_id: &str,
    new_id: &str,
    note: Option<&str>,
) -> Result<String, BranchError> {
    let raw = fs::read_to_string(workspace_path)?;
    let mut value = serde_yaml::from_str::<YamlValue>(&raw)?;
    let mapping = value
        .as_mapping_mut()
        .ok_or(BranchError::InvalidWorkspace)?;
    let base_title = first_non_empty(mapping, ["name", "summary"])
        .unwrap_or_else(|| format!("Session {}", parent_id.chars().take(8).collect::<String>()));
    let new_name = format!(
        "Branch: {} [{}]",
        compact(&base_title, 72),
        new_id.chars().take(8).collect::<String>()
    );
    let now = now_iso();
    set(mapping, "id", new_id);
    set(mapping, "name", &new_name);
    set_bool(mapping, "user_named", true);
    set(mapping, "summary", &new_name);
    set(mapping, "created_at", &now);
    set(mapping, "updated_at", &now);
    set(mapping, "branch_of", parent_id);
    let branch_note = note
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("Branched from: {base_title} ({parent_id})"));
    set(mapping, "branch_note", &branch_note);
    fs::write(workspace_path, serde_yaml::to_string(&value)?)?;
    Ok(new_name)
}

fn rewrite_session_start(path: &Path, new_id: &str, new_name: &str) -> Result<(), BranchError> {
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let mut event = match serde_json::from_str::<JsonValue>(line) {
            Ok(event) => event,
            Err(_) => {
                out.push(line.to_owned());
                continue;
            }
        };
        if event.get("type").and_then(JsonValue::as_str) == Some("session.start") {
            if let Some(data) = event.get_mut("data").and_then(JsonValue::as_object_mut) {
                data.insert("sessionId".into(), JsonValue::String(new_id.into()));
                if data.contains_key("alreadyInUse") {
                    data.insert("alreadyInUse".into(), JsonValue::Bool(false));
                }
                for key in ["name", "title", "summary"] {
                    if data.contains_key(key) {
                        data.insert(key.into(), JsonValue::String(new_name.into()));
                    }
                }
            }
        }
        out.push(serde_json::to_string(&event)?);
    }
    fs::write(path, format!("{}\n", out.join("\n")))?;
    Ok(())
}

fn reset_rewind(staging: &Path) -> Result<(), BranchError> {
    let rewind_dir = staging.join("rewind-snapshots");
    fs::create_dir_all(&rewind_dir)?;
    fs::write(rewind_dir.join("index.json"), REWIND_INDEX_JSON)?;
    let backup_dir = rewind_dir.join("backups");
    if backup_dir.exists() {
        for entry in fs::read_dir(backup_dir)?.flatten() {
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

fn reset_checkpoints(staging: &Path) -> Result<(), BranchError> {
    let checkpoint_dir = staging.join("checkpoints");
    fs::create_dir_all(&checkpoint_dir)?;
    fs::write(checkpoint_dir.join("index.md"), CHECKPOINT_INDEX_HEADER)?;
    Ok(())
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), BranchError> {
    let mut last_error = None;
    for _ in 0..12 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    Err(BranchError::Io(
        last_error.unwrap_or_else(|| io::Error::other("rename failed")),
    ))
}

fn first_non_empty(
    mapping: &Mapping,
    keys: impl IntoIterator<Item = &'static str>,
) -> Option<String> {
    for key in keys {
        if let Some(value) = mapping
            .get(YamlValue::String(key.into()))
            .and_then(YamlValue::as_str)
        {
            if !value.trim().is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn set(mapping: &mut Mapping, key: &str, value: &str) {
    mapping.insert(
        YamlValue::String(key.into()),
        YamlValue::String(value.into()),
    );
}

fn set_bool(mapping: &mut Mapping, key: &str, value: bool) {
    mapping.insert(YamlValue::String(key.into()), YamlValue::Bool(value));
}

fn compact(value: &str, max_len: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() <= max_len {
        compact
    } else {
        format!("{}...", compact[..max_len.saturating_sub(3)].trim_end())
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
