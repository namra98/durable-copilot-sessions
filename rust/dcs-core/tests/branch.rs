use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dcs_core::branch::branch_session;
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;

const PARENT_ID: &str = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW_ID: &str = "bbbbbbbb-5555-6666-7777-888888888888";

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("dcs-rust-branch-{}-{nanos}", std::process::id()))
}

fn write_parent(state_dir: &Path) {
    let dir = state_dir.join(PARENT_ID);
    fs::create_dir_all(dir.join("checkpoints")).unwrap();
    fs::create_dir_all(dir.join("rewind-snapshots").join("backups").join("snap1")).unwrap();
    fs::write(
        dir.join("workspace.yaml"),
        format!("id: {PARENT_ID}\ncwd: C:/repo/x\nname: Design The Thing\nuser_named: false\n"),
    )
    .unwrap();
    fs::write(
        dir.join("events.jsonl"),
        format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "session.start",
                "data": {
                    "sessionId": PARENT_ID,
                    "name": "Design The Thing",
                    "alreadyInUse": true
                }
            }),
            serde_json::json!({ "type": "user.message", "data": { "text": "hi" } })
        ),
    )
    .unwrap();
    fs::write(dir.join("session.db"), "SQLITEDB").unwrap();
    fs::write(dir.join("inuse.4242.lock"), "4242").unwrap();
    fs::write(
        dir.join("checkpoints").join("index.md"),
        "# old checkpoints\nstuff\n",
    )
    .unwrap();
    fs::write(
        dir.join("rewind-snapshots")
            .join("backups")
            .join("snap1")
            .join("f.txt"),
        "x",
    )
    .unwrap();
}

#[test]
fn branch_session_creates_lineage_and_resets_volatile_state() {
    let state_dir = temp_root();
    write_parent(&state_dir);

    let result = branch_session(&state_dir, PARENT_ID, Some("trying an idea"), Some(NEW_ID))
        .expect("branch succeeds");
    assert_eq!(result.new_session_id, NEW_ID);
    assert!(result
        .new_session_name
        .starts_with("Branch: Design The Thing [bbbbbbbb]"));

    let dir = state_dir.join(NEW_ID);
    assert!(dir.exists());
    let workspace =
        serde_yaml::from_str::<YamlValue>(&fs::read_to_string(dir.join("workspace.yaml")).unwrap())
            .unwrap();
    assert_eq!(workspace["id"], NEW_ID);
    assert_eq!(workspace["branch_of"], PARENT_ID);
    assert_eq!(workspace["user_named"], true);
    assert_eq!(workspace["branch_note"], "trying an idea");
    assert_eq!(workspace["cwd"], "C:/repo/x");

    assert!(!dir.join("session.db").exists());
    assert!(!fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("inuse.")));
    assert!(fs::read_to_string(dir.join("checkpoints").join("index.md"))
        .unwrap()
        .contains("# Checkpoint History"));
    assert!(!dir
        .join("rewind-snapshots")
        .join("backups")
        .join("snap1")
        .exists());

    let first_event = fs::read_to_string(dir.join("events.jsonl"))
        .unwrap()
        .lines()
        .next()
        .map(|line| serde_json::from_str::<JsonValue>(line).unwrap())
        .unwrap();
    assert_eq!(first_event["type"], "session.start");
    assert_eq!(first_event["data"]["sessionId"], NEW_ID);
    assert_eq!(first_event["data"]["alreadyInUse"], false);
    assert!(first_event["data"]["name"]
        .as_str()
        .unwrap()
        .starts_with("Branch:"));

    fs::remove_dir_all(state_dir).unwrap();
}

#[test]
fn branch_session_never_modifies_parent_and_rejects_invalid_inputs() {
    let state_dir = temp_root();
    write_parent(&state_dir);

    assert!(branch_session(&state_dir, "nope", None, Some(NEW_ID)).is_err());
    branch_session(&state_dir, PARENT_ID, None, Some(NEW_ID)).expect("branch succeeds");
    assert!(branch_session(&state_dir, PARENT_ID, None, Some(NEW_ID)).is_err());

    let parent_workspace = serde_yaml::from_str::<YamlValue>(
        &fs::read_to_string(state_dir.join(PARENT_ID).join("workspace.yaml")).unwrap(),
    )
    .unwrap();
    assert_eq!(parent_workspace["id"], PARENT_ID);
    assert!(parent_workspace["branch_of"].is_null());
    assert!(state_dir.join(PARENT_ID).join("session.db").exists());

    fs::remove_dir_all(state_dir).unwrap();
}
