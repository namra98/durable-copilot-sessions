use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dcs_core::discovery::{list_sessions, DiscoveryOptions, ProcessSnapshot};
use dcs_core::model::SessionLiveness;

fn temp_root() -> PathBuf {
    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("dcs-rust-perf-{}-{nanos}-{id}", std::process::id()))
}

fn write_session(root: &Path, index: usize, live_pid: Option<u32>) {
    let id = format!("session-{index:04}");
    let dir = root.join(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("workspace.yaml"),
        format!(
            "id: session-{index:04}\ncwd: {}\nname: Session {index}\nclient_name: github/cli\nupdated_at: 2026-07-09T00:{:02}:00Z\nrepository: repo-{}\n",
            root.display(),
            index % 60,
            index % 16
        ),
    )
    .unwrap();
    if let Some(pid) = live_pid {
        fs::write(dir.join(format!("inuse.{pid}.lock")), pid.to_string()).unwrap();
    }
}

#[test]
fn live_only_discovery_remains_fast_on_large_session_state_tree() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let mut snapshot: ProcessSnapshot = BTreeMap::new();

    for index in 0..600 {
        let live_pid = (index < 12).then_some(50_000 + index as u32);
        if let Some(pid) = live_pid {
            snapshot.insert(pid, "node.exe".into());
        }
        write_session(&root, index, live_pid);
    }

    let mut options = DiscoveryOptions::new(&root);
    options.live_only = true;
    options.process_snapshot = snapshot;

    let started = Instant::now();
    let sessions = list_sessions(&options);
    let elapsed = started.elapsed();

    assert_eq!(sessions.len(), 12);
    assert!(sessions
        .iter()
        .all(|session| matches!(session.liveness, SessionLiveness::Live)));
    assert!(
        elapsed < Duration::from_secs(5),
        "live-only discovery over 600 sessions took {elapsed:?}"
    );

    fs::remove_dir_all(root).unwrap();
}
