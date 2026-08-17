use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dcs_core::doctor::{aggregate, DoctorCheck};
use dcs_core::scheduling::{
    build_create_logon_args, build_create_snapshot_args, build_delete_args, build_query_args,
    install_startup_restore, install_tasks, startup_restore_installed, startup_restore_script_path,
    tasks_status, uninstall_startup_restore, uninstall_tasks, write_hidden_launcher,
    TaskExecResult, LOGON_TASK_NAME, SNAPSHOT_TASK_NAME, STARTUP_RESTORE_SCRIPT_NAME,
};

fn temp_root() -> PathBuf {
    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "dcs-rust-scheduling-{}-{nanos}-{id}",
        std::process::id()
    ))
}

#[test]
fn scheduled_task_arg_builders_match_windows_contract() {
    let snapshot = build_create_snapshot_args("X snapshot", 5);
    assert_eq!(snapshot[0], "/Create");
    assert!(snapshot.contains(&"DAILY".to_owned()));
    assert!(snapshot.contains(&"/RI".to_owned()));
    assert_eq!(
        snapshot[snapshot.iter().position(|arg| arg == "/RI").unwrap() + 1],
        "5"
    );
    assert!(snapshot.contains(&"/DU".to_owned()));
    assert_eq!(
        snapshot[snapshot.iter().position(|arg| arg == "/TR").unwrap() + 1],
        "X snapshot"
    );
    assert!(snapshot.contains(&SNAPSHOT_TASK_NAME.to_owned()));

    let logon = build_create_logon_args("X restore-prompt");
    assert!(logon.contains(&"ONLOGON".to_owned()));
    assert!(logon.contains(&LOGON_TASK_NAME.to_owned()));
    assert_eq!(
        logon[logon.iter().position(|arg| arg == "/TR").unwrap() + 1],
        "X restore-prompt"
    );

    assert_eq!(build_delete_args("T"), ["/Delete", "/TN", "T", "/F"]);
    assert_eq!(build_query_args("T"), ["/Query", "/TN", "T"]);
}

#[test]
fn hidden_launcher_writes_vbs_action_with_escaped_quotes() {
    let root = temp_root();
    let inner = r#""C:\dcs-rs.exe" snapshot"#;
    let action = write_hidden_launcher("snapshot", inner, &root).unwrap();
    let vbs_path = root.join("snapshot.vbs");

    assert_eq!(
        action,
        format!("wscript.exe //B //Nologo \"{}\"", vbs_path.display())
    );
    let script = fs::read_to_string(&vbs_path).unwrap();
    assert!(script.contains(".Run \""));
    assert!(script.contains("\", 0, False"));
    assert!(script.contains(r#"""C:\dcs-rs.exe"" snapshot"#));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_fallback_writes_and_removes_hidden_restore_launcher() {
    let root = temp_root();
    let command = r#""C:\dcs-rs.exe" restore-prompt"#;
    let path = install_startup_restore(command, &root).unwrap();

    assert_eq!(path, startup_restore_script_path(&root));
    assert_eq!(path.file_name().unwrap(), STARTUP_RESTORE_SCRIPT_NAME);
    assert!(startup_restore_installed(&root));

    let script = fs::read_to_string(&path).unwrap();
    assert!(script.contains(".Run \""));
    assert!(script.contains("\", 0, False"));
    assert!(script.contains(r#"""C:\dcs-rs.exe"" restore-prompt"#));

    assert!(uninstall_startup_restore(&root).unwrap());
    assert!(!uninstall_startup_restore(&root).unwrap());
    assert!(!startup_restore_installed(&root));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn task_operations_use_executor_seam_and_report_status() {
    let mut calls = Vec::new();
    let installed = install_tasks("X snapshot", "X restore-prompt", 5, |args| {
        calls.push(args.to_vec());
        TaskExecResult {
            status: Some(0),
            stdout: None,
            stderr: None,
            error: None,
        }
    });
    assert!(installed.snapshot);
    assert!(installed.logon);
    assert_eq!(calls.len(), 2);

    let failed = install_tasks("X snapshot", "X restore-prompt", 5, |_args| {
        TaskExecResult {
            status: Some(1),
            stdout: None,
            stderr: Some("boom".into()),
            error: None,
        }
    });
    assert!(!failed.snapshot);
    assert!(!failed.logon);
    assert!(failed
        .messages
        .iter()
        .any(|message| message.contains("boom")));

    let removed = uninstall_tasks(|_args| TaskExecResult {
        status: Some(1),
        stdout: None,
        stderr: Some("cannot find task".into()),
        error: None,
    });
    assert!(removed
        .messages
        .iter()
        .all(|message| message.contains("was not present")));

    let mut query_count = 0;
    let status = tasks_status(|_args| {
        query_count += 1;
        TaskExecResult {
            status: Some(if query_count == 1 { 0 } else { 1 }),
            stdout: None,
            stderr: None,
            error: None,
        }
    });
    assert!(status.snapshot);
    assert!(!status.logon);
}

#[test]
fn doctor_aggregate_fails_if_any_check_fails() {
    let report = aggregate(vec![
        DoctorCheck {
            name: "ok".into(),
            ok: true,
            detail: "ok".into(),
        },
        DoctorCheck {
            name: "bad".into(),
            ok: false,
            detail: "bad".into(),
        },
    ]);
    assert!(!report.ok);
    assert_eq!(report.checks.len(), 2);
}
