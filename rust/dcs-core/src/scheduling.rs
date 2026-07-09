use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

pub const SNAPSHOT_TASK_NAME: &str = "DurableCopilotSessions-Snapshot";
pub const LOGON_TASK_NAME: &str = "DurableCopilotSessions-LogonRestore";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskExecResult {
    pub status: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallTasksResult {
    pub snapshot: bool,
    pub logon: bool,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallTasksResult {
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TasksStatus {
    pub snapshot: bool,
    pub logon: bool,
}

#[derive(Debug)]
pub enum SchedulingError {
    Io(io::Error),
}

impl fmt::Display for SchedulingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for SchedulingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for SchedulingError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn build_create_snapshot_args(command: &str, interval_minutes: u32) -> Vec<String> {
    vec![
        "/Create".into(),
        "/TN".into(),
        SNAPSHOT_TASK_NAME.into(),
        "/SC".into(),
        "DAILY".into(),
        "/ST".into(),
        "00:00".into(),
        "/RI".into(),
        interval_minutes.to_string(),
        "/DU".into(),
        "24:00".into(),
        "/TR".into(),
        command.into(),
        "/RL".into(),
        "LIMITED".into(),
        "/F".into(),
    ]
}

pub fn build_create_logon_args(command: &str) -> Vec<String> {
    vec![
        "/Create".into(),
        "/TN".into(),
        LOGON_TASK_NAME.into(),
        "/SC".into(),
        "ONLOGON".into(),
        "/TR".into(),
        command.into(),
        "/RL".into(),
        "LIMITED".into(),
        "/F".into(),
    ]
}

pub fn build_delete_args(task_name: &str) -> Vec<String> {
    vec![
        "/Delete".into(),
        "/TN".into(),
        task_name.into(),
        "/F".into(),
    ]
}

pub fn build_query_args(task_name: &str) -> Vec<String> {
    vec!["/Query".into(), "/TN".into(), task_name.into()]
}

pub fn write_hidden_launcher(
    name: &str,
    inner_command: &str,
    dir: impl AsRef<Path>,
) -> Result<String, SchedulingError> {
    let dir = dir.as_ref();
    fs::create_dir_all(dir)?;
    let vbs_path = dir.join(format!("{name}.vbs"));
    let escaped = inner_command.replace('"', "\"\"");
    fs::write(
        &vbs_path,
        format!("CreateObject(\"WScript.Shell\").Run \"{escaped}\", 0, False\r\n"),
    )?;
    Ok(format!(
        "wscript.exe //B //Nologo \"{}\"",
        vbs_path.to_string_lossy()
    ))
}

pub fn run_schtasks(args: &[String]) -> TaskExecResult {
    match Command::new("schtasks.exe").args(args).output() {
        Ok(output) => TaskExecResult {
            status: output.status.code(),
            stdout: text(output.stdout),
            stderr: text(output.stderr),
            error: None,
        },
        Err(error) => TaskExecResult {
            status: None,
            stdout: None,
            stderr: None,
            error: Some(error.to_string()),
        },
    }
}

pub fn install_tasks<F>(
    snapshot_command: &str,
    restore_prompt_command: &str,
    interval_minutes: u32,
    mut exec: F,
) -> InstallTasksResult
where
    F: FnMut(&[String]) -> TaskExecResult,
{
    let mut messages = Vec::new();
    let snapshot_result = exec(&build_create_snapshot_args(
        snapshot_command,
        interval_minutes,
    ));
    let snapshot = snapshot_result.status == Some(0);
    if snapshot {
        messages.push(format!(
            "Registered scheduled task {SNAPSHOT_TASK_NAME} (snapshot every {interval_minutes} min)."
        ));
    } else {
        messages.push(format!(
            "Failed to register {SNAPSHOT_TASK_NAME}: {}",
            failure_detail(&snapshot_result)
        ));
    }

    let logon_result = exec(&build_create_logon_args(restore_prompt_command));
    let logon = logon_result.status == Some(0);
    if logon {
        messages.push(format!(
            "Registered scheduled task {LOGON_TASK_NAME} (restore prompt at logon)."
        ));
    } else {
        messages.push(format!(
            "Failed to register {LOGON_TASK_NAME}: {}",
            failure_detail(&logon_result)
        ));
    }

    InstallTasksResult {
        snapshot,
        logon,
        messages,
    }
}

pub fn uninstall_tasks<F>(mut exec: F) -> UninstallTasksResult
where
    F: FnMut(&[String]) -> TaskExecResult,
{
    let mut messages = Vec::new();
    for task_name in [SNAPSHOT_TASK_NAME, LOGON_TASK_NAME] {
        let result = exec(&build_delete_args(task_name));
        if result.status == Some(0) {
            messages.push(format!("Removed scheduled task {task_name}."));
        } else if is_not_found(&result) {
            messages.push(format!("Scheduled task {task_name} was not present."));
        } else {
            messages.push(format!(
                "Failed to remove {task_name}: {}",
                failure_detail(&result)
            ));
        }
    }
    UninstallTasksResult { messages }
}

pub fn tasks_status<F>(mut exec: F) -> TasksStatus
where
    F: FnMut(&[String]) -> TaskExecResult,
{
    TasksStatus {
        snapshot: exec(&build_query_args(SNAPSHOT_TASK_NAME)).status == Some(0),
        logon: exec(&build_query_args(LOGON_TASK_NAME)).status == Some(0),
    }
}

fn text(bytes: Vec<u8>) -> Option<String> {
    let value = String::from_utf8_lossy(&bytes).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn failure_detail(result: &TaskExecResult) -> String {
    result
        .stderr
        .as_deref()
        .or(result.error.as_deref())
        .filter(|detail| !detail.trim().is_empty())
        .unwrap_or("unknown error")
        .trim()
        .to_owned()
}

fn is_not_found(result: &TaskExecResult) -> bool {
    let text = format!(
        "{} {}",
        result.stderr.as_deref().unwrap_or_default(),
        result.error.as_deref().unwrap_or_default()
    );
    let lower = text.to_lowercase();
    lower.contains("cannot find")
        || lower.contains("does not exist")
        || lower.contains("the system cannot find the file")
        || lower.contains("the system cannot find the path")
}
