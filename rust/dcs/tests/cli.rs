use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn temp_root() -> PathBuf {
    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("dcs-rust-cli-{}-{nanos}-{id}", std::process::id()))
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &dest);
        } else {
            fs::copy(entry.path(), dest).unwrap();
        }
    }
}

fn fixture_root(root: &Path) -> (PathBuf, PathBuf) {
    let fixtures = repo_root().join("tests").join("fixtures").join("contracts");
    let copilot_home = root.join("copilot-home");
    let state_dir = root.join("state");
    copy_dir(&fixtures.join("copilot-home"), &copilot_home);
    copy_dir(&fixtures.join("owned-state"), &state_dir);
    (copilot_home, state_dir)
}

fn run_cli(root: &Path, args: &[&str]) -> Output {
    let (copilot_home, state_dir) = fixture_root(root);
    Command::new(env!("CARGO_BIN_EXE_dcs-rs"))
        .args(args)
        .env("DCS_COPILOT_HOME", copilot_home)
        .env("DCS_STATE_DIR", state_dir)
        .output()
        .unwrap()
}

#[test]
fn help_lists_the_contract_cli_commands() {
    let root = temp_root();
    let output = run_cli(&root, &["--help"]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for command in [
        "list",
        "resume",
        "fork",
        "serve",
        "install-tasks",
        "tasks-status",
        "doctor",
    ] {
        assert!(stdout.contains(command), "missing command {command}");
    }
    assert!(stdout.contains("Start or reuse the local Rust API server"));
    assert!(stdout.contains("Show command descriptions"));

    let ui_help = run_cli(&root, &["help", "ui"]);
    assert!(ui_help.status.success());
    let ui_stdout = String::from_utf8_lossy(&ui_help.stdout);
    assert!(ui_stdout.contains("Usage:"));
    assert!(ui_stdout.contains("dcs ui [--port n]"));
    assert!(ui_stdout.contains("If the port is already in use"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn list_and_export_workspaces_use_frozen_fixtures() {
    let root = temp_root();
    let list = run_cli(&root, &["list", "--all"]);
    assert!(list.status.success());
    let stdout = String::from_utf8_lossy(&list.stdout);
    assert!(stdout.contains("11111111"));
    assert!(stdout.contains("durable-copilot-sessions"));

    let export = run_cli(&root, &["export-workspaces"]);
    assert!(export.status.success());
    let json: serde_json::Value = serde_json::from_slice(&export.stdout).unwrap();
    assert_eq!(json["kind"], "durable-copilot-sessions/workspaces");
    assert!(!json["workspaces"].as_array().unwrap().is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn new_session_dry_run_creates_launch_script_without_spawning_wt() {
    let root = temp_root();
    let output = run_cli(
        &root,
        &[
            "new",
            "New Rust Session",
            "--cwd",
            "C:\\definitely-missing-dcs-cli-test",
            "--prompt",
            "hello from cli",
            "--dry-run",
        ],
    );
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Launched new session"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("does not exist"));

    let scripts = fs::read_dir(root.join("state").join("launch-scripts"))
        .unwrap()
        .flatten()
        .map(|entry| fs::read_to_string(entry.path()).unwrap())
        .collect::<Vec<_>>();
    assert!(scripts
        .iter()
        .any(|script| script.contains("hello from cli")));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_reports_friendly_port_conflict() {
    let root = temp_root();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port().to_string();

    let output = run_cli(&root, &["serve", "--port", &port]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("already in use"));
    assert!(stderr.contains("dcs ui"));

    drop(listener);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ui_rejects_occupied_port_that_is_not_dcs_server() {
    let root = temp_root();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0; 512];
                    let _ = stream.read(&mut buffer);
                    let body = "not dcs";
                    let response = format!(
                        "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    break;
                }
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let output = run_cli(&root, &["ui", "--port", &port]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("already in use"));
    assert!(stderr.contains("does not look like an existing DCS server"));

    server.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tasks_status_reports_startup_fallback() {
    let root = temp_root();
    let output = run_cli(&root, &["tasks-status"]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Snapshot task:"));
    assert!(stdout.contains("Logon restore task:"));
    assert!(stdout.contains("Startup fallback:"));

    fs::remove_dir_all(root).unwrap();
}
