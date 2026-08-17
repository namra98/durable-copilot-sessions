use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dcs_core::contract::{load_backend_contract, BackendContract};
use dcs_core::model::{
    DiscoveredSession, ManagedSession, SessionLiveness, Workspace, WorkspaceExport, WorkspaceSource,
};
use dcs_core::registry::{
    default_config, diff_workspace, export_workspaces, load_config, parse_workspace_export,
    save_config, CreateWorkspaceInput, ManagedSessionPatch, Registry, RegistryDirs,
};
use serde::de::DeserializeOwned;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn contract() -> BackendContract {
    load_backend_contract(repo_root().join("contracts").join("backend-api.v1.json")).unwrap()
}

fn fixture_path(contract: &BackendContract, key: &str) -> PathBuf {
    repo_root().join(contract.fixtures.get(key).unwrap())
}

fn read_json<T: DeserializeOwned>(path: impl AsRef<Path>) -> T {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("dcs-rust-registry-{}-{nanos}", std::process::id()))
}

fn registry_dirs(root: &Path) -> RegistryDirs {
    RegistryDirs {
        managed_dir: root.join("registry").join("sessions"),
        workspaces_dir: root.join("registry").join("workspaces"),
        snapshots_dir: root.join("snapshots"),
    }
}

#[test]
fn config_load_merges_defaults_and_save_writes_json() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let config_file = root.join("config.json");
    fs::write(
        &config_file,
        r#"{ "apiPort": 5000, "copilotArgs": ["--yolo"] }"#,
    )
    .unwrap();

    let config = load_config(&config_file);

    assert_eq!(config.api_port, 5000);
    assert_eq!(config.web_port, default_config().web_port);
    assert_eq!(config.copilot_args, vec!["--yolo"]);

    save_config(&config_file, &default_config()).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();
    assert_eq!(saved["apiPort"], 4517);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn registry_reads_fixtures_and_round_trips_owned_state() {
    let contract = contract();
    let root = temp_root();
    let dirs = registry_dirs(&root);
    fs::create_dir_all(&dirs.managed_dir).unwrap();
    fs::create_dir_all(&dirs.workspaces_dir).unwrap();
    fs::copy(
        fixture_path(&contract, "managedSession"),
        dirs.managed_dir
            .join("11111111-1111-1111-1111-111111111111.json"),
    )
    .unwrap();
    fs::copy(
        fixture_path(&contract, "workspace"),
        dirs.workspaces_dir.join("workspace-morning.json"),
    )
    .unwrap();

    let registry = Registry::new(dirs.clone()).unwrap();

    assert_eq!(registry.list_managed().len(), 1);
    assert_eq!(
        registry
            .get_managed("11111111-1111-1111-1111-111111111111")
            .unwrap()
            .title
            .as_deref(),
        Some("Morning backend session")
    );
    assert_eq!(registry.list_workspaces()[0].name, "morning-layout");
    assert!(registry.get_workspace("../bad").is_none());

    let managed = registry
        .upsert_managed(ManagedSessionPatch {
            session_id: "11111111-1111-1111-1111-111111111111".into(),
            title: Some("Renamed".into()),
            color: None,
            group: None,
            pinned: None,
            hidden: None,
            tags: Some(vec![]),
            archived: None,
        })
        .unwrap();
    assert_eq!(managed.title.as_deref(), Some("Renamed"));
    assert_eq!(managed.tags, Some(vec![]));

    let created = registry
        .create_workspace(CreateWorkspaceInput {
            name: "created".into(),
            description: None,
            source: WorkspaceSource::Manual,
            windows: Vec::new(),
        })
        .unwrap();
    assert_eq!(registry.get_workspace(&created.id).unwrap().name, "created");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn snapshots_are_filename_sorted_and_pruned_by_retention() {
    let root = temp_root();
    let registry = Registry::new(registry_dirs(&root)).unwrap();
    let mut first: Workspace = read_json(fixture_path(&contract(), "workspace"));
    first.id = "first".into();
    first.created_at = "2026-07-09T00:00:00.000Z".into();
    let mut second = first.clone();
    second.id = "second".into();
    second.created_at = "2026-07-09T01:00:00.000Z".into();

    registry.add_snapshot(&first, 2).unwrap();
    registry.add_snapshot(&second, 1).unwrap();

    let snapshots = registry.list_snapshots();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].id, "second");
    assert_eq!(registry.latest_snapshot().unwrap().id, "second");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_export_fixture_parses_and_exports_with_same_envelope() {
    let contract = contract();
    let raw = fs::read_to_string(fixture_path(&contract, "workspaceExport")).unwrap();
    let parsed = parse_workspace_export(&raw).unwrap();
    let fixture: WorkspaceExport = serde_json::from_str(&raw).unwrap();

    assert_eq!(parsed, fixture.workspaces);

    let exported = export_workspaces(parsed, fixture.exported_at).unwrap();
    let exported_value: WorkspaceExport = serde_json::from_str(&exported).unwrap();
    assert_eq!(exported_value.kind, "durable-copilot-sessions/workspaces");
    assert_eq!(exported_value.version, 1);
}

#[test]
fn workspace_diff_matches_current_bucket_contract() {
    let contract = contract();
    let workspace: Workspace = read_json(fixture_path(&contract, "workspace"));
    let live = vec![
        DiscoveredSession {
            id: "11111111-1111-1111-1111-111111111111".into(),
            cwd: r"C:\Users\example\repos\other".into(),
            cwd_exists: true,
            name: Some("Morning backend session".into()),
            summary: None,
            git_root: None,
            repository: None,
            branch: Some("main".into()),
            client_name: None,
            created_at: None,
            updated_at: None,
            liveness: SessionLiveness::Live,
            live_pids: vec![4242],
            top_level: true,
            branch_of: None,
            branch_note: None,
        },
        DiscoveredSession {
            id: "new-live".into(),
            cwd: r"C:\Users\example\repos\durable-copilot-sessions".into(),
            cwd_exists: true,
            name: Some("New live".into()),
            summary: None,
            git_root: None,
            repository: None,
            branch: None,
            client_name: None,
            created_at: None,
            updated_at: None,
            liveness: SessionLiveness::Live,
            live_pids: vec![4242],
            top_level: true,
            branch_of: None,
            branch_note: None,
        },
    ];

    let diff = diff_workspace(&workspace, &live);

    assert_eq!(diff.stale_cwd.len(), 1);
    assert_eq!(diff.added_live[0].session_id, "new-live");
    assert_eq!(diff.unchanged, 0);
}

#[test]
fn corrupt_json_files_are_skipped_when_listing() {
    let root = temp_root();
    let dirs = registry_dirs(&root);
    fs::create_dir_all(&dirs.managed_dir).unwrap();
    fs::write(dirs.managed_dir.join("bad.json"), "{").unwrap();
    fs::write(
        dirs.managed_dir.join("good.json"),
        serde_json::to_string(&ManagedSession {
            session_id: "good".into(),
            title: None,
            color: None,
            group: None,
            pinned: None,
            hidden: None,
            tags: None,
            archived: None,
            updated_at: "2026-07-09T00:00:00Z".into(),
        })
        .unwrap(),
    )
    .unwrap();

    let registry = Registry::new(dirs).unwrap();

    assert_eq!(registry.list_managed().len(), 1);

    fs::remove_dir_all(root).unwrap();
}
