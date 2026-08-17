use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::launch::resolve_executable_in_path;
use crate::paths::DcsPaths;
use crate::scheduling::{run_schtasks, tasks_status};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoctorCheck {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub ok: bool,
}

pub fn aggregate(checks: Vec<DoctorCheck>) -> DoctorReport {
    let ok = checks.iter().all(|check| check.ok);
    DoctorReport { checks, ok }
}

pub fn run_doctor(paths: &DcsPaths) -> DoctorReport {
    let path_value = std::env::var("PATH").unwrap_or_default();
    let resolve = |name: &str| {
        resolve_executable_in_path(name, &path_value, std::env::var("PATHEXT").ok().as_deref())
    };

    let checks = vec![
        check_executable(
            "Windows Terminal (wt.exe)",
            "wt",
            "not found on PATH - install Windows Terminal and ensure wt.exe is on PATH.",
            &resolve,
        ),
        check_shell(&resolve),
        check_executable(
            "Copilot CLI (copilot)",
            "copilot",
            "not found on PATH - install the Copilot CLI so resumed tabs can start it.",
            &resolve,
        ),
        check_rust_binary(),
        check_sqlite(),
        check_state_dir(paths),
        check_session_state(paths),
        check_tasks(),
    ];
    aggregate(checks)
}

fn check_executable<F>(name: &str, executable: &str, missing: &str, resolve: &F) -> DoctorCheck
where
    F: Fn(&str) -> Option<PathBuf>,
{
    let found = resolve(executable);
    DoctorCheck {
        name: name.into(),
        ok: found.is_some(),
        detail: found
            .map(|path| format!("found at {}", path.display()))
            .unwrap_or_else(|| missing.into()),
    }
}

fn check_shell<F>(resolve: &F) -> DoctorCheck
where
    F: Fn(&str) -> Option<PathBuf>,
{
    let found = resolve("pwsh").or_else(|| resolve("powershell"));
    DoctorCheck {
        name: "PowerShell".into(),
        ok: found.is_some(),
        detail: found
            .map(|path| format!("found at {}", path.display()))
            .unwrap_or_else(|| {
                "no pwsh.exe or powershell.exe on PATH - install PowerShell 7 (pwsh).".into()
            }),
    }
}

fn check_rust_binary() -> DoctorCheck {
    match std::env::current_exe() {
        Ok(path) => DoctorCheck {
            name: "Rust backend binary".into(),
            ok: true,
            detail: format!("running from {}", path.display()),
        },
        Err(error) => DoctorCheck {
            name: "Rust backend binary".into(),
            ok: false,
            detail: format!("could not resolve current executable: {error}"),
        },
    }
}

fn check_sqlite() -> DoctorCheck {
    DoctorCheck {
        name: "SQLite/FTS5".into(),
        ok: true,
        detail: "bundled rusqlite SQLite is available for stats and memory.".into(),
    }
}

fn check_state_dir(paths: &DcsPaths) -> DoctorCheck {
    let _ = paths.ensure_owned_dirs();
    let ok = write_probe(&paths.state_dir);
    DoctorCheck {
        name: "State directory writable".into(),
        ok,
        detail: if ok {
            format!("writable: {}", paths.state_dir.display())
        } else {
            format!(
                "cannot write to {} - check permissions.",
                paths.state_dir.display()
            )
        },
    }
}

fn check_session_state(paths: &DcsPaths) -> DoctorCheck {
    let ok = fs::read_dir(&paths.copilot_session_state_dir).is_ok();
    DoctorCheck {
        name: "Copilot session-state readable".into(),
        ok,
        detail: if ok {
            format!("readable: {}", paths.copilot_session_state_dir.display())
        } else {
            format!(
                "cannot read {} - is the Copilot CLI installed and has it run at least once?",
                paths.copilot_session_state_dir.display()
            )
        },
    }
}

fn check_tasks() -> DoctorCheck {
    let status = tasks_status(run_schtasks);
    let ok = status.snapshot && status.logon;
    DoctorCheck {
        name: "Scheduled tasks".into(),
        ok,
        detail: if ok {
            "snapshot + logon tasks installed.".into()
        } else {
            format!(
                "snapshot: {}, logon: {} - run `dcs install-tasks`.",
                if status.snapshot {
                    "installed"
                } else {
                    "missing"
                },
                if status.logon { "installed" } else { "missing" }
            )
        },
    }
}

fn write_probe(dir: &Path) -> bool {
    let probe = dir.join(format!(
        ".dcs-doctor-{}-{}.tmp",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let result = fs::write(&probe, "ok").is_ok();
    let _ = fs::remove_file(probe);
    result
}
