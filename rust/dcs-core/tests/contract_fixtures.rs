use std::fs;
use std::path::PathBuf;

use dcs_core::contract::{load_backend_contract, BackendContract};
use dcs_core::model::{
    AppConfig, GraphModel, ManagedSession, SessionListResult, SessionRole, Workspace,
    WorkspaceExport, WorkspaceYaml,
};
use dcs_core::BACKEND_CONTRACT_KIND;
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

fn read_json<T: DeserializeOwned>(path: PathBuf) -> T {
    let raw = fs::read_to_string(path).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn parses_backend_contract() {
    let contract = contract();

    assert_eq!(contract.kind, BACKEND_CONTRACT_KIND);
    assert_eq!(contract.version, 1);
    assert_eq!(contract.api_base, "/api");
    assert!(contract
        .routes
        .iter()
        .any(|route| route.method == "GET" && route.path == "/sessions"));
    assert!(contract
        .cli
        .commands
        .iter()
        .any(|command| command.name == "doctor"));
}

#[test]
fn decodes_owned_state_fixtures() {
    let contract = contract();

    let config: AppConfig = read_json(fixture_path(&contract, "appConfig"));
    let managed: ManagedSession = read_json(fixture_path(&contract, "managedSession"));
    let workspace: Workspace = read_json(fixture_path(&contract, "workspace"));
    let exported: WorkspaceExport = read_json(fixture_path(&contract, "workspaceExport"));

    assert_eq!(config.api_port, 4517);
    assert_eq!(managed.session_id, "11111111-1111-1111-1111-111111111111");
    assert_eq!(workspace.windows.len(), 1);
    assert_eq!(exported.kind, "durable-copilot-sessions/workspaces");
    assert_eq!(exported.workspaces[0], workspace);
}

#[test]
fn decodes_copilot_workspace_yaml_fixture() {
    let contract = contract();
    let raw = fs::read_to_string(fixture_path(&contract, "workspaceYaml")).unwrap();
    let workspace: WorkspaceYaml = serde_yaml::from_str(&raw).unwrap();

    assert_eq!(workspace.id, "11111111-1111-1111-1111-111111111111");
    assert_eq!(
        workspace.repository.as_deref(),
        Some("namra98/durable-copilot-sessions")
    );
    assert_eq!(workspace.client_name.as_deref(), Some("github/cli"));
}

#[test]
fn decodes_api_response_fixtures() {
    let contract = contract();

    let sessions: SessionListResult = read_json(fixture_path(&contract, "apiSessionsOpen"));
    let graph: GraphModel = read_json(fixture_path(&contract, "apiGraphOpen"));

    assert_eq!(sessions.open_count, 1);
    assert_eq!(sessions.sessions[0].role, Some(SessionRole::Primary));
    assert_eq!(graph.open_count, sessions.open_count);
}
