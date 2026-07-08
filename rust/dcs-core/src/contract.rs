use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendContract {
    pub kind: String,
    pub version: u32,
    pub api_base: String,
    pub compatibility: Compatibility,
    pub routes: Vec<RouteContract>,
    pub cli: CliContract,
    pub environment: Vec<EnvironmentVariable>,
    pub state: StateContract,
    pub fixtures: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub scope: String,
    pub frontend_status: String,
    pub state_policy: String,
    pub copilot_state_policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteContract {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Vec<String>,
    #[serde(default)]
    pub request: Option<String>,
    pub response: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliContract {
    pub commands: Vec<CliCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliCommand {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentVariable {
    pub name: String,
    pub effect: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateContract {
    pub owned_root: String,
    pub copilot_root: String,
    pub schemas: StateSchemas,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateSchemas {
    #[serde(rename = "AppConfig")]
    pub app_config: SchemaContract,
    #[serde(rename = "ManagedSession")]
    pub managed_session: SchemaContract,
    #[serde(rename = "Workspace")]
    pub workspace: SchemaContract,
    #[serde(rename = "WindowSpec")]
    pub window_spec: SchemaContract,
    #[serde(rename = "TabSpec")]
    pub tab_spec: SchemaContract,
    #[serde(rename = "WorkspaceExport")]
    pub workspace_export: SchemaContract,
    #[serde(rename = "WorkspaceYaml")]
    pub workspace_yaml: SchemaContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaContract {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub required_fields: Vec<String>,
    #[serde(default)]
    pub optional_fields: Vec<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub version: Option<u32>,
}

#[derive(Debug)]
pub enum ContractLoadError {
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for ContractLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "failed to read backend contract: {error}"),
            Self::Json(error) => write!(formatter, "failed to parse backend contract: {error}"),
        }
    }
}

impl Error for ContractLoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
        }
    }
}

impl From<std::io::Error> for ContractLoadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ContractLoadError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub fn load_backend_contract(path: impl AsRef<Path>) -> Result<BackendContract, ContractLoadError> {
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}
