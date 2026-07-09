use std::fs;
use std::io;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DcsPaths {
    pub copilot_home: PathBuf,
    pub copilot_session_state_dir: PathBuf,
    pub copilot_session_store_db: PathBuf,
    pub state_dir: PathBuf,
    pub registry_dir: PathBuf,
    pub managed_sessions_dir: PathBuf,
    pub workspaces_dir: PathBuf,
    pub snapshots_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub launch_scripts_dir: PathBuf,
    pub launchers_dir: PathBuf,
    pub config_file: PathBuf,
    pub memory_db: PathBuf,
}

impl DcsPaths {
    pub fn from_env() -> Self {
        let home = home_dir();
        let copilot_home = std::env::var_os("DCS_COPILOT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".copilot"));
        let state_dir = std::env::var_os("DCS_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".durable-copilot-sessions").join("state"));
        Self::from_roots(copilot_home, state_dir)
    }

    pub fn from_roots(copilot_home: PathBuf, state_dir: PathBuf) -> Self {
        let registry_dir = state_dir.join("registry");
        Self {
            copilot_session_state_dir: copilot_home.join("session-state"),
            copilot_session_store_db: copilot_home.join("session-store.db"),
            copilot_home,
            managed_sessions_dir: registry_dir.join("sessions"),
            workspaces_dir: registry_dir.join("workspaces"),
            snapshots_dir: state_dir.join("snapshots"),
            logs_dir: state_dir.join("logs"),
            launch_scripts_dir: state_dir.join("launch-scripts"),
            launchers_dir: state_dir.join("launchers"),
            config_file: state_dir.join("config.json"),
            memory_db: state_dir.join("memory.db"),
            registry_dir,
            state_dir,
        }
    }

    pub fn ensure_owned_dirs(&self) -> io::Result<()> {
        for dir in [
            &self.state_dir,
            &self.registry_dir,
            &self.managed_sessions_dir,
            &self.workspaces_dir,
            &self.snapshots_dir,
            &self.logs_dir,
            &self.launch_scripts_dir,
            &self.launchers_dir,
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
