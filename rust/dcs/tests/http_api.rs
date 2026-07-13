use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use dcs_core::discovery::ProcessSnapshot;
use dcs_core::manager::SessionManager;
use dcs_core::paths::DcsPaths;
use dcs_rs::server::router;
use serde_json::Value;
use tower::ServiceExt;

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
    std::env::temp_dir().join(format!("dcs-rust-http-{}-{nanos}-{id}", std::process::id()))
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

fn fixture_manager(root: &Path) -> SessionManager {
    let fixtures = repo_root().join("tests").join("fixtures").join("contracts");
    let copilot_home = root.join("copilot-home");
    let state_dir = root.join("state");
    copy_dir(&fixtures.join("copilot-home"), &copilot_home);
    copy_dir(&fixtures.join("owned-state"), &state_dir);
    let paths = DcsPaths::from_roots(copilot_home, state_dir);
    let snapshot: ProcessSnapshot = BTreeMap::from([(4242, "node.exe".to_owned())]);
    SessionManager::with_process_snapshot_for_tests(paths, snapshot).unwrap()
}

async fn json_response(
    app: axum::Router,
    method: &str,
    uri: &str,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.unwrap_or_default().to_owned()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = serde_json::from_slice::<Value>(&bytes).unwrap();
    (status, value)
}

async fn text_response(app: axum::Router, method: &str, uri: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    (status, text)
}

async fn json_response_with_header(
    app: axum::Router,
    method: &str,
    uri: &str,
    header_name: &str,
    header_value: &str,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header(header_name, header_value)
        .body(Body::from(body.unwrap_or_default().to_owned()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = serde_json::from_slice::<Value>(&bytes).unwrap();
    (status, value)
}

#[tokio::test]
async fn sessions_and_graph_routes_use_frozen_envelopes_and_ordering() {
    let root = temp_root();
    let app = router(Arc::new(Mutex::new(fixture_manager(&root))));

    let (status, sessions) =
        json_response(app.clone(), "GET", "/api/sessions?filter=open", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions["openCount"], 1);
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        sessions["sessions"][0]["id"],
        "11111111-1111-1111-1111-111111111111"
    );
    assert_eq!(sessions["sessions"][0]["role"], "primary");
    assert_eq!(sessions["sessions"][0]["childCount"], 1);

    let (status, graph) = json_response(app.clone(), "GET", "/api/graph?filter=all", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
    assert!(graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["kind"] == "fork"));

    let (status, stale) = json_response(app.clone(), "GET", "/api/sessions/stale", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(stale["sessions"].is_array());

    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn mutating_routes_reject_cross_site_browser_requests() {
    let root = temp_root();
    let app = router(Arc::new(Mutex::new(fixture_manager(&root))));

    let (status, blocked) = json_response_with_header(
        app.clone(),
        "POST",
        "/api/workspaces",
        "sec-fetch-site",
        "cross-site",
        Some(r#"{"name":"blocked","windows":[]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(blocked["error"].as_str().unwrap().contains("Cross-site"));

    let (status, created) = json_response_with_header(
        app.clone(),
        "POST",
        "/api/workspaces",
        "origin",
        "http://localhost:4516",
        Some(r#"{"name":"local","windows":[]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["workspace"]["name"], "local");

    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn config_logs_memory_and_workspace_routes_keep_response_wrappers() {
    let root = temp_root();
    let app = router(Arc::new(Mutex::new(fixture_manager(&root))));

    let (status, config) = json_response(app.clone(), "GET", "/api/config", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(config["config"]["apiPort"], 4517);

    let (status, logs) = json_response(app.clone(), "GET", "/api/logs?lines=5", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(logs["logs"].is_array());

    let (status, search) =
        json_response(app.clone(), "GET", "/api/memory/search?q=backend", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(search["hits"].is_array());

    let (status, recall) = json_response(app.clone(), "GET", "/api/memory/recall", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(recall["pack"].is_object());

    let (status, workspaces) = json_response(app.clone(), "GET", "/api/workspaces", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(workspaces["workspaces"].is_array());

    let (status, created) = json_response(
        app.clone(),
        "POST",
        "/api/workspaces",
        Some(r#"{"name":"second","windows":[]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["workspace"]["name"], "second");

    let (status, exported) = json_response(
        app.clone(),
        "GET",
        "/api/workspaces/export?ids=workspace-morning",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(exported["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(exported["workspaces"][0]["id"], "workspace-morning");

    let (status, snapshots) = json_response(app.clone(), "GET", "/api/snapshots", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(snapshots["snapshots"].is_array());

    let (status, restore_prompt) = text_response(app.clone(), "GET", "/restore-prompt").await;
    assert_eq!(status, StatusCode::OK);
    assert!(restore_prompt.contains("<title>Restore Copilot sessions</title>"));
    assert!(restore_prompt.contains("Restore latest snapshot"));

    let (status, unknown) = json_response(app.clone(), "GET", "/api/does-not-exist", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(unknown["error"], "Not found");

    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn promotes_requested_snapshot_and_validates_sensitive_inputs() {
    let root = temp_root();
    let app = router(Arc::new(Mutex::new(fixture_manager(&root))));
    let newer_snapshot = root
        .join("state")
        .join("snapshots")
        .join("2026-07-09T01-00-00-000Z-newer-snapshot.json");
    fs::write(
        newer_snapshot,
        r#"{
  "id": "newer-snapshot",
  "name": "newer",
  "source": "auto-snapshot",
  "createdAt": "2026-07-09T01:00:00.000Z",
  "updatedAt": "2026-07-09T01:00:00.000Z",
  "windows": []
}"#,
    )
    .unwrap();

    let (status, promoted) = json_response(
        app.clone(),
        "POST",
        "/api/workspaces/snapshot-open/promote",
        Some(r#"{"name":"selected snapshot"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(promoted["workspace"]["name"], "selected snapshot");
    assert_eq!(
        promoted["workspace"]["windows"].as_array().unwrap().len(),
        1
    );

    let (status, transcript) =
        json_response(app.clone(), "GET", "/api/sessions/bad.id/transcript", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(transcript["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session id"));

    let (status, clean) = json_response(
        app.clone(),
        "POST",
        "/api/sessions/clean",
        Some(r#"{"remove":true}"#),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(clean["error"]
        .as_str()
        .unwrap()
        .contains("confirmCopilotStateWrite"));

    let (status, fork) = json_response(
        app.clone(),
        "POST",
        "/api/sessions/11111111-1111-1111-1111-111111111111/fork?dryRun=true",
        Some(r#"{"note":"blocked by default"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(fork["error"]
        .as_str()
        .unwrap()
        .contains("confirmCopilotStateWrite"));

    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn fork_and_new_session_routes_preserve_launch_contracts() {
    let root = temp_root();
    let app = router(Arc::new(Mutex::new(fixture_manager(&root))));

    let (status, fork) = json_response(
        app.clone(),
        "POST",
        "/api/sessions/11111111-1111-1111-1111-111111111111/fork?dryRun=true",
        Some(r#"{"note":"trying rust","launch":true,"color":"green","window":"current","confirmCopilotStateWrite":true}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        fork["fork"]["parentId"],
        "11111111-1111-1111-1111-111111111111"
    );
    assert_eq!(
        fork["session"]["branchOf"],
        "11111111-1111-1111-1111-111111111111"
    );
    assert_eq!(fork["session"]["liveness"], "inactive");
    assert_eq!(fork["launch"]["ok"], true);
    assert_eq!(fork["launch"]["tabsLaunched"], 1);

    let fork_id = fork["fork"]["newSessionId"].as_str().unwrap();
    let fork_dir = root
        .join("copilot-home")
        .join("session-state")
        .join(fork_id);
    assert!(fork_dir.join("workspace.yaml").exists());
    assert!(!fork_dir.join("session.db").exists());
    assert!(!fs::read_dir(&fork_dir)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("inuse.")));

    let (status, new_session) = json_response(
        app.clone(),
        "POST",
        "/api/sessions/new?dryRun=true",
        Some(r#"{"title":"New Rust Session","cwd":"C:\\definitely-missing-dcs-test","color":"blue","prompt":"hello"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(new_session["ok"], true);
    assert_eq!(new_session["tabsLaunched"], 1);
    assert!(new_session["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning.as_str().unwrap().contains("does not exist")));

    let launch_scripts = fs::read_dir(root.join("state").join("launch-scripts"))
        .unwrap()
        .flatten()
        .map(|entry| fs::read_to_string(entry.path()).unwrap())
        .collect::<Vec<_>>();
    assert!(launch_scripts.iter().any(|script| script.contains("hello")));

    drop(app);
    fs::remove_dir_all(root).unwrap();
}
