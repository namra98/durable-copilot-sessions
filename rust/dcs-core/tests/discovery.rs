use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dcs_core::discovery::{get_session, list_sessions, DiscoveryOptions, ProcessSnapshot};
use dcs_core::model::SessionLiveness;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn contract_fixture_state_dir() -> PathBuf {
    repo_root()
        .join("tests")
        .join("fixtures")
        .join("contracts")
        .join("copilot-home")
        .join("session-state")
}

fn snapshot(pid: u32, image: &str) -> ProcessSnapshot {
    BTreeMap::from([(pid, image.to_owned())])
}

fn unique_temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("dcs-rust-discovery-{}-{nanos}", std::process::id()))
}

fn write_session(root: &Path, id: &str, yaml: &str, lock_pid: Option<u32>) {
    let dir = root.join(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("workspace.yaml"), yaml).unwrap();
    if let Some(pid) = lock_pid {
        fs::write(dir.join(format!("inuse.{pid}.lock")), "").unwrap();
    }
}

#[test]
fn discovers_contract_workspace_yaml_and_lock_fixtures() {
    let mut options = DiscoveryOptions::new(contract_fixture_state_dir());
    options.process_snapshot = snapshot(4242, "node.exe");

    let sessions = list_sessions(&options);

    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].id, "22222222-2222-2222-2222-222222222222");
    assert_eq!(sessions[0].liveness, SessionLiveness::Live);
    assert_eq!(sessions[0].live_pids, vec![4242]);
    assert!(!sessions[0].top_level);
    assert_eq!(
        sessions[0].branch_of.as_deref(),
        Some("11111111-1111-1111-1111-111111111111")
    );
    assert_eq!(sessions[1].id, "11111111-1111-1111-1111-111111111111");
    assert!(sessions[1].top_level);
}

#[test]
fn supports_single_session_lookup_without_scanning_everything() {
    let mut options = DiscoveryOptions::new(contract_fixture_state_dir());
    options.process_snapshot = snapshot(4242, "copilot.exe");

    let session = get_session(&options, "11111111-1111-1111-1111-111111111111").unwrap();

    assert_eq!(session.name.as_deref(), Some("Morning backend session"));
    assert_eq!(
        session.repository.as_deref(),
        Some("namra98/durable-copilot-sessions")
    );
    assert_eq!(session.liveness, SessionLiveness::Live);
    assert!(get_session(&options, "does-not-exist").is_none());
}

#[test]
fn classifies_stale_inactive_and_live_only_without_parsing_inactive_yaml() {
    let root = unique_temp_dir();
    fs::create_dir_all(&root).unwrap();
    write_session(
        &root,
        "live",
        "id: live\ncwd: C:\\\\live\nclient_name: github/cli\nupdated_at: 2026-07-09T00:10:00.000Z\n",
        Some(1111),
    );
    write_session(
        &root,
        "stale",
        "id: stale\ncwd: C:\\\\stale\nclient_name: github/cli\nupdated_at: 2026-07-09T00:20:00.000Z\n",
        Some(2222),
    );
    write_session(
        &root,
        "inactive",
        "id: inactive\ncwd: C:\\\\inactive\nclient_name: github/cli\nupdated_at: 2026-07-09T00:30:00.000Z\n",
        None,
    );
    let malformed = root.join("malformed");
    fs::create_dir_all(&malformed).unwrap();
    fs::write(malformed.join("workspace.yaml"), "cwd: [").unwrap();

    let mut options = DiscoveryOptions::new(&root);
    options.process_snapshot = snapshot(1111, "node.exe");
    let sessions = list_sessions(&options);
    let live = sessions
        .iter()
        .find(|session| session.id == "live")
        .unwrap();
    let stale = sessions
        .iter()
        .find(|session| session.id == "stale")
        .unwrap();
    let inactive = sessions
        .iter()
        .find(|session| session.id == "inactive")
        .unwrap();

    assert_eq!(live.liveness, SessionLiveness::Live);
    assert_eq!(stale.liveness, SessionLiveness::Stale);
    assert_eq!(inactive.liveness, SessionLiveness::Inactive);

    options.live_only = true;
    let live_only = list_sessions(&options);
    assert_eq!(live_only.len(), 1);
    assert_eq!(live_only[0].id, "live");

    fs::remove_dir_all(root).unwrap();
}
