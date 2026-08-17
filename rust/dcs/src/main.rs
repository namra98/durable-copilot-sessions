use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use dcs_core::doctor::run_doctor;
use dcs_core::manager::SessionManager;
use dcs_core::model::{
    CleanStaleBody, CreateWorkspaceBody, ForkBody, ImportWorkspacesBody, LaunchResult, MemoryKind,
    MemorySearchParams, NewSessionBody, ResumeBatchBody, ResumeBody, SessionFilter,
    SessionLiveness, WindowTarget, Workspace,
};
use dcs_core::paths::DcsPaths;
use dcs_core::registry::load_config;
use dcs_core::scheduling::{
    default_startup_dir, install_startup_restore, install_tasks, run_schtasks,
    startup_restore_installed, tasks_status, uninstall_startup_restore, uninstall_tasks,
    write_hidden_launcher,
};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = Args::new(std::env::args().skip(1).collect());
    let command = args.take_command();
    if let Some(name) = command.as_deref() {
        if name != "help" && args.has_help_flag() {
            return print_command_help(name);
        }
    }
    match command.as_deref() {
        None | Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some("--version") | Some("-V") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("help") => help_command(args),
        Some("serve") => serve_command(args, ServeMode::Serve).await,
        Some("ui") => serve_command(args, ServeMode::Ui).await,
        Some("restore-prompt") => restore_prompt_command().await,
        Some("list") => list_command(args),
        Some("resume") => resume_command(args),
        Some("fork") => fork_command(args),
        Some("recall") => recall_command(args),
        Some("reindex-memory") => reindex_memory_command(),
        Some("save") => save_command(args),
        Some("restore") => restore_command(args),
        Some("resume-repo") => resume_repo_command(args),
        Some("restore-last") => restore_last_command(args),
        Some("snapshot") => snapshot_command(),
        Some("new") => new_command(args),
        Some("clean") => clean_command(args),
        Some("stats") => stats_command(),
        Some("transcript") => transcript_command(args),
        Some("logs") => logs_command(args),
        Some("export-workspaces") => export_workspaces_command(args),
        Some("import-workspaces") => import_workspaces_command(args),
        Some("diff") => diff_command(args),
        Some("tray") => tray_command(),
        Some("install-tasks") => install_tasks_command(args),
        Some("uninstall-tasks") => uninstall_tasks_command(),
        Some("tasks-status") => tasks_status_command(),
        Some("doctor") => doctor_command(args),
        Some(other) => Err(format!("Unknown command: {other}").into()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServeMode {
    Serve,
    Ui,
}

async fn serve_command(mut args: Args, mode: ServeMode) -> Result<(), Box<dyn std::error::Error>> {
    let paths = DcsPaths::from_env();
    let config = load_config(&paths.config_file);
    let port = args
        .take_option("--port")
        .or_else(|| args.take_next())
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(config.api_port);
    let ui_url = format!("http://127.0.0.1:{port}/restore-prompt");
    let open_url = (mode == ServeMode::Ui && config.auto_open_browser).then_some(ui_url);
    serve_local_api(paths, port, open_url, mode).await
}

fn list_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let tree = args.take_flag("--tree");
    let filter = if args.take_flag("--all") {
        SessionFilter::All
    } else if args.take_flag("--live") {
        SessionFilter::Live
    } else {
        SessionFilter::Open
    };
    let manager = manager()?;
    let result = manager.list_sessions(filter);
    print_sessions(&result.sessions, tree, Some(result.open_count));
    Ok(())
}

fn resume_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = required_arg(&mut args, "sessionId")?;
    let dry_run = args.take_flag("--dry-run");
    let body = ResumeBody {
        window: parse_window(args.take_option("--window"))?,
        color: args.take_option("--color"),
        title: args.take_option("--title"),
        cwd: None,
    };
    print_launch(manager()?.resume_session(&session_id, body, dry_run)?);
    Ok(())
}

fn fork_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = required_arg(&mut args, "sessionId")?;
    let dry_run = args.take_flag("--dry-run");
    let body = ForkBody {
        note: args.take_option("--note"),
        launch: Some(args.take_flag("--launch")),
        color: args.take_option("--color"),
        window: parse_window(args.take_option("--window"))?,
        confirm_copilot_state_write: Some(args.take_flag("--confirm-copilot-state-write")),
    };
    let result = manager()?.fork_session(&session_id, body, dry_run)?;
    println!("Forked -> {}", result.fork.new_session_id);
    println!("  name: {}", result.fork.new_session_name);
    println!("  path: {}", result.fork.new_session_path);
    if let Some(launch) = result.launch {
        print_launch(launch);
    }
    Ok(())
}

fn recall_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let repo = args.take_option("--repo");
    let kind = parse_memory_kind(args.take_option("--kind"))?;
    let limit = args
        .take_option("--limit")
        .and_then(|value| value.parse::<u32>().ok())
        .or(Some(10));
    let query = args.remaining().join(" ");
    if query.trim().is_empty() {
        return Err("recall requires a query".into());
    }
    let hits = manager()?.search_memory(MemorySearchParams {
        q: query,
        repository: repo,
        kind,
        limit,
    });
    if hits.is_empty() {
        println!("No memories found. (Run `dcs reindex-memory` to build the index.)");
        return Ok(());
    }
    for hit in &hits {
        let memory = &hit.memory;
        println!(
            "[{:?}] {}{}",
            memory.kind,
            memory
                .title
                .clone()
                .unwrap_or_else(|| memory.session_id.chars().take(8).collect()),
            memory
                .repository
                .as_ref()
                .map(|repo| format!("  ({repo})"))
                .unwrap_or_default()
        );
        println!(
            "   {}",
            hit.snippet
                .clone()
                .unwrap_or_else(|| memory.content.chars().take(160).collect())
        );
    }
    println!("\n{} memory result(s).", hits.len());
    Ok(())
}

fn reindex_memory_command() -> Result<(), Box<dyn std::error::Error>> {
    let mut manager = manager()?;
    let count = manager.reindex_memory()?;
    println!("Indexed {count} memories.");
    Ok(())
}

fn save_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let name = required_arg(&mut args, "name")?;
    let filter = if args.take_flag("--all") {
        SessionFilter::All
    } else {
        SessionFilter::Live
    };
    let workspace = manager()?.create_workspace(CreateWorkspaceBody {
        name,
        description: args.take_option("--description"),
        from_live: Some(true),
        filter: Some(filter),
        windows: None,
    })?;
    println!(
        "Saved workspace \"{}\" ({}) - {} tab(s) across {} window(s).",
        workspace.name,
        workspace.id,
        tab_count(&workspace),
        workspace.windows.len()
    );
    Ok(())
}

fn restore_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let name_or_id = required_arg(&mut args, "nameOrId")?;
    let dry_run = args.take_flag("--dry-run");
    let window = parse_window(args.take_option("--window"))?;
    let manager = manager()?;
    let id = manager
        .list_workspaces()
        .into_iter()
        .find(|workspace| workspace.name == name_or_id || workspace.id == name_or_id)
        .map(|workspace| workspace.id)
        .unwrap_or(name_or_id);
    print_launch(manager.restore_workspace(&id, window, dry_run)?);
    Ok(())
}

fn resume_repo_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let repository = required_arg(&mut args, "repository")?;
    let dry_run = args.take_flag("--dry-run");
    let window = parse_window(args.take_option("--window"))?;
    let manager = manager()?;
    let needle = repository.to_lowercase();
    let ids = manager
        .list_sessions(SessionFilter::Open)
        .sessions
        .into_iter()
        .filter(|session| {
            [
                &session.repository,
                &session.git_root,
                &Some(session.cwd.clone()),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(&needle))
        })
        .map(|session| session.id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        println!("No open sessions match \"{repository}\".");
        return Ok(());
    }
    println!(
        "Resuming {} open session(s) matching \"{repository}\".",
        ids.len()
    );
    print_launch(manager.resume_batch(
        ResumeBatchBody {
            session_ids: ids,
            window,
        },
        dry_run,
    )?);
    Ok(())
}

fn restore_last_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let dry_run = args.take_flag("--dry-run");
    let window = parse_window(args.take_option("--window"))?;
    let manager = manager()?;
    let latest = match manager.latest_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => {
            println!("No snapshot available to restore. Take one with `dcs snapshot`.");
            return Ok(());
        }
    };
    println!(
        "Restoring last snapshot ({}) - {} session(s) across {} window(s).",
        latest.created_at,
        tab_count(&latest),
        latest.windows.len()
    );
    print_launch(manager.restore_latest_snapshot(window, dry_run)?);
    Ok(())
}

fn snapshot_command() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = manager()?.snapshot()?;
    println!(
        "Snapshot {}: {} live session(s) across {} window(s).",
        workspace.id,
        tab_count(&workspace),
        workspace.windows.len()
    );
    Ok(())
}

async fn restore_prompt_command() -> Result<(), Box<dyn std::error::Error>> {
    let paths = DcsPaths::from_env();
    let config = load_config(&paths.config_file);
    if matches!(
        config.restore_on_login,
        dcs_core::model::RestoreOnLogin::Off
    ) {
        return Ok(());
    }
    let manager = SessionManager::new(paths.clone())?;
    let latest = match manager.latest_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => {
            println!("No snapshot available to restore.");
            return Ok(());
        }
    };
    println!(
        "Last snapshot ({}) has {} session(s) across {} window(s).",
        latest.created_at,
        tab_count(&latest),
        latest.windows.len()
    );
    if matches!(
        config.restore_on_login,
        dcs_core::model::RestoreOnLogin::Auto
    ) {
        print_launch(manager.restore_workspace(&latest.id, None, false)?);
        return Ok(());
    }
    let url = format!("http://127.0.0.1:{}/restore-prompt", config.api_port);
    let open_url = config.auto_open_browser.then_some(url);
    serve_local_api(paths, config.api_port, open_url, ServeMode::Ui).await
}

fn new_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let title = required_arg(&mut args, "title")?;
    let dry_run = args.take_flag("--dry-run");
    let cwd = args
        .take_option("--cwd")
        .map(|value| absolute_path_string(&value))
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .into_owned()
        });
    let body = NewSessionBody {
        title: title.clone(),
        cwd: cwd.clone(),
        color: args.take_option("--color").or_else(|| Some("blue".into())),
        prompt: args.take_option("--prompt"),
        window: parse_window(args.take_option("--window"))?,
    };
    let result = manager()?.new_session(body, dry_run)?;
    if result.ok {
        println!("Launched new session \"{title}\" in {cwd}.");
    } else {
        eprintln!(
            "Failed: {}",
            result.error.unwrap_or_else(|| "unknown error".into())
        );
        std::process::exit(1);
    }
    for warning in &result.warnings {
        eprintln!("  ! {warning}");
    }
    Ok(())
}

fn clean_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let remove = args.take_flag("--remove");
    let result = manager()?.clean_stale(CleanStaleBody {
        remove: Some(remove),
        confirm_copilot_state_write: Some(args.take_flag("--confirm-copilot-state-write")),
    })?;
    println!(
        "Stale sessions: {}{}",
        result["stale"].as_u64().unwrap_or(0),
        if remove {
            format!(
                "; removed {} stale lock file(s).",
                result["removed"].as_u64().unwrap_or(0)
            )
        } else {
            " (stale locks are reported without modifying Copilot state).".into()
        }
    );
    Ok(())
}

fn stats_command() -> Result<(), Box<dyn std::error::Error>> {
    let stats = manager()?.stats();
    println!(
        "Sessions: {}  |  checkpoints: {}  |  turns: {}",
        stats.total_sessions, stats.total_checkpoints, stats.total_turns
    );
    println!("Top repositories:");
    for repo in stats.top_repos.iter().take(10) {
        println!("  {:>4}  {}", repo.sessions, repo.repository);
    }
    Ok(())
}

fn transcript_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = required_arg(&mut args, "sessionId")?;
    let markdown = manager()?.transcript(&session_id)?;
    if let Some(out) = args.take_option("--out").or_else(|| args.take_option("-o")) {
        fs::write(&out, markdown)?;
        println!("Wrote {out}");
    } else {
        println!("{markdown}");
    }
    Ok(())
}

fn logs_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let lines = args
        .take_option("--lines")
        .and_then(|value| value.parse::<usize>().ok())
        .or(Some(200));
    let level = args.take_option("--level");
    for record in manager()?.tail_logs(lines, level.as_deref()) {
        println!(
            "{} {:<5} {}{}",
            record.ts.unwrap_or_default(),
            record.level.unwrap_or_default().to_uppercase(),
            record
                .scope
                .map(|scope| format!("[{scope}] "))
                .unwrap_or_default(),
            record.message.unwrap_or_default()
        );
    }
    Ok(())
}

fn export_workspaces_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let out = args.take_next();
    let json = manager()?.export_workspaces(None)?;
    if let Some(file) = out {
        fs::write(&file, json)?;
        println!("Wrote {file}");
    } else {
        println!("{json}");
    }
    Ok(())
}

fn import_workspaces_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let file = required_arg(&mut args, "file")?;
    let fresh_ids = args.take_flag("--fresh-ids");
    let json = fs::read_to_string(file)?;
    let workspaces = manager()?.import_workspaces(ImportWorkspacesBody {
        json,
        fresh_ids: Some(fresh_ids),
    })?;
    println!("Imported {} workspace(s).", workspaces.len());
    Ok(())
}

fn diff_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let name_or_id = required_arg(&mut args, "workspace")?;
    let manager = manager()?;
    let id = manager
        .list_workspaces()
        .into_iter()
        .find(|workspace| workspace.name == name_or_id || workspace.id == name_or_id)
        .map(|workspace| workspace.id)
        .unwrap_or(name_or_id);
    match manager.workspace_diff(&id) {
        Ok(diff) => {
            println!(
                "missing {} * staleCwd {} * changed {} * addedLive {} * unchanged {}",
                diff.missing.len(),
                diff.stale_cwd.len(),
                diff.changed.len(),
                diff.added_live.len(),
                diff.unchanged
            );
            for entry in diff.missing {
                println!("  - missing: {}", entry.title);
            }
            for entry in diff.stale_cwd {
                println!("  ~ cwd:     {} ({})", entry.title, entry.detail);
            }
        }
        Err(_) => println!("Workspace not found."),
    }
    Ok(())
}

fn tray_command() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let tray_script = root.join("scripts").join("tray.ps1");
    if !tray_script.exists() {
        return Err(format!("Tray script not found: {}", tray_script.display()).into());
    }
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &tray_script.to_string_lossy(),
        ])
        .spawn()?;
    println!("System tray started.");
    Ok(())
}

fn install_tasks_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let interval = args
        .take_option("--interval")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(5);
    let hidden = !args.take_flag("--no-hidden");
    let paths = DcsPaths::from_env();
    paths.ensure_owned_dirs()?;
    let snapshot_inner = resolve_cli_command("snapshot")?;
    let restore_inner = resolve_cli_command("restore-prompt")?;
    let snapshot_command = if hidden {
        write_hidden_launcher("snapshot", &snapshot_inner, &paths.launchers_dir)?
    } else {
        snapshot_inner
    };
    let restore_prompt_command = if hidden {
        write_hidden_launcher("logon-restore", &restore_inner, &paths.launchers_dir)?
    } else {
        restore_inner.clone()
    };
    let result = install_tasks(
        &snapshot_command,
        &restore_prompt_command,
        interval,
        run_schtasks,
    );
    for message in result.messages {
        println!("{message}");
    }
    if !result.logon {
        let startup_dir = default_startup_dir();
        match install_startup_restore(&restore_inner, &startup_dir) {
            Ok(path) => println!(
                "Installed current-user Startup fallback for logon restore: {}",
                path.display()
            ),
            Err(error) => eprintln!(
                "Failed to install current-user Startup fallback in {}: {error}",
                startup_dir.display()
            ),
        }
    }
    Ok(())
}

fn uninstall_tasks_command() -> Result<(), Box<dyn std::error::Error>> {
    for message in uninstall_tasks(run_schtasks).messages {
        println!("{message}");
    }
    let startup_dir = default_startup_dir();
    match uninstall_startup_restore(&startup_dir) {
        Ok(true) => println!(
            "Removed current-user Startup fallback from {}.",
            startup_dir.display()
        ),
        Ok(false) => println!("Current-user Startup fallback was not present."),
        Err(error) => eprintln!(
            "Failed to remove current-user Startup fallback from {}: {error}",
            startup_dir.display()
        ),
    }
    Ok(())
}

fn tasks_status_command() -> Result<(), Box<dyn std::error::Error>> {
    let status = tasks_status(run_schtasks);
    let startup_dir = default_startup_dir();
    let startup = startup_restore_installed(&startup_dir);
    println!(
        "Snapshot task:      {}",
        if status.snapshot {
            "installed"
        } else {
            "not installed"
        }
    );
    println!(
        "Logon restore task: {}",
        if status.logon {
            "installed"
        } else {
            "not installed"
        }
    );
    println!(
        "Startup fallback:   {}",
        if startup {
            "installed"
        } else {
            "not installed"
        }
    );
    Ok(())
}

fn doctor_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let json = args.take_flag("--json");
    let paths = DcsPaths::from_env();
    let report = run_doctor(&paths);
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for check in &report.checks {
            println!(
                "{}  {} - {}",
                if check.ok { "OK" } else { "FAIL" },
                check.name,
                check.detail
            );
        }
        println!(
            "\n{}",
            if report.ok {
                "All checks passed."
            } else {
                "Some checks failed."
            }
        );
    }
    if !report.ok {
        std::process::exit(1);
    }
    Ok(())
}

async fn serve_local_api(
    paths: DcsPaths,
    port: u16,
    open_url: Option<String>,
    mode: ServeMode,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error)
            if error.kind() == ErrorKind::AddrInUse
                && mode == ServeMode::Ui
                && is_dcs_server(addr) =>
        {
            let url = open_url.unwrap_or_else(|| format!("http://{addr}/restore-prompt"));
            println!("Port {port} is already in use; reusing the server at {url}.");
            open_local_url_after_delay(url);
            return Ok(());
        }
        Err(error) if error.kind() == ErrorKind::AddrInUse && mode == ServeMode::Ui => {
            return Err(format!(
                "Port {port} is already in use, but it does not look like an existing DCS server. Stop the other process or choose another port."
            )
            .into());
        }
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            return Err(format!(
                "Port {port} is already in use. If this is an existing DCS server, use `dcs ui` to open it, or run `dcs serve --port <free-port>`."
            )
            .into());
        }
        Err(error) => return Err(error.into()),
    };

    if let Some(url) = open_url {
        println!("Open {url} to review and restore.");
        open_local_url_after_delay(url);
    }
    println!("API listening: http://{addr}/api  (Ctrl+C to stop)");
    dcs_rs::server::serve_listener(listener, paths).await
}

fn is_dcs_server(addr: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));

    let request = format!("GET /api/health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return false;
    }

    let Ok(body) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };
    body.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && body
            .get("version")
            .is_some_and(serde_json::Value::is_string)
}

fn open_local_url_after_delay(url: String) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Err(error) = Command::new("cmd").args(["/C", "start", "", &url]).spawn() {
            eprintln!("Failed to open {url}: {error}");
        }
    });
}

fn manager() -> Result<SessionManager, Box<dyn std::error::Error>> {
    Ok(SessionManager::new(DcsPaths::from_env())?)
}

fn print_launch(result: LaunchResult) {
    if result.ok {
        println!(
            "OK - opened {} tab(s) in {} window(s).",
            result.tabs_launched, result.windows_opened
        );
    } else {
        eprintln!(
            "Failed: {}",
            result.error.unwrap_or_else(|| "unknown error".into())
        );
        std::process::exit(1);
    }
    for warning in result.warnings {
        eprintln!("  ! {warning}");
    }
}

fn print_sessions(sessions: &[dcs_core::model::SessionView], tree: bool, open_count: Option<u32>) {
    if sessions.is_empty() {
        println!("No sessions found.");
        return;
    }
    for session in sessions {
        let badge = match session.liveness {
            SessionLiveness::Live => "* live ",
            SessionLiveness::Stale => "o stale",
            SessionLiveness::Inactive => "  idle ",
        };
        let title = session
            .title
            .as_ref()
            .or(session.name.as_ref())
            .cloned()
            .unwrap_or_else(|| session.id.chars().take(8).collect());
        let repo = session
            .repository
            .as_ref()
            .map(|repository| {
                session
                    .branch
                    .as_ref()
                    .map(|branch| format!("{repository}@{branch}"))
                    .unwrap_or_else(|| repository.clone())
            })
            .unwrap_or_default();
        let child = if tree && session.role == Some(dcs_core::model::SessionRole::Primary) {
            session
                .child_count
                .filter(|count| *count > 0)
                .map(|count| format!("  +{count}"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        println!(
            "{}  {}  {}{}",
            badge,
            session.id.chars().take(8).collect::<String>(),
            title,
            child
        );
        println!(
            "          {}{}",
            session.cwd,
            if repo.is_empty() {
                String::new()
            } else {
                format!("   [{repo}]")
            }
        );
    }
    if let Some(open_count) = open_count {
        println!(
            "\n{} session(s); {open_count} open terminal(s).",
            sessions.len()
        );
    } else {
        println!("\n{} session(s).", sessions.len());
    }
}

struct CommandHelp {
    name: &'static str,
    usage: &'static str,
    description: &'static str,
    notes: Option<&'static [&'static str]>,
}

const COMMAND_HELP: &[CommandHelp] = &[
    CommandHelp {
        name: "list",
        usage: "list [--live|--all] [--tree]",
        description: "List discovered Copilot sessions; defaults to open top-level terminal sessions.",
        notes: Some(&[
            "`--live` shows only sessions with live lock PIDs.",
            "`--all` includes stale and inactive sessions.",
            "`--tree` groups child sessions under their open terminal parent.",
        ]),
    },
    CommandHelp {
        name: "resume",
        usage: "resume <sessionId> [--window new|current] [--color color] [--title title] [--dry-run]",
        description: "Open a Windows Terminal tab that runs `copilot --resume <sessionId>`.",
        notes: Some(&["`--dry-run` writes the launch script without starting Windows Terminal."]),
    },
    CommandHelp {
        name: "fork",
        usage: "fork <sessionId> [--note text] [--launch] [--color color] [--window new|current] [--dry-run] --confirm-copilot-state-write",
        description: "Create a forked Copilot session-state entry and record lineage for the graph.",
        notes: Some(&[
            "Requires `--confirm-copilot-state-write` because it writes under Copilot-owned session state.",
            "`--launch` immediately opens the fork after creating it.",
        ]),
    },
    CommandHelp {
        name: "recall",
        usage: "recall <query...> [--repo repository] [--kind kind] [--limit n]",
        description: "Search the local memory index for relevant past session context.",
        notes: Some(&["Run `dcs reindex-memory` if recall returns no results after new activity."]),
    },
    CommandHelp {
        name: "reindex-memory",
        usage: "reindex-memory",
        description: "Rebuild the local memory/recall index from readable Copilot session data.",
        notes: None,
    },
    CommandHelp {
        name: "save",
        usage: "save <name> [--all] [--description text]",
        description: "Save the current layout as a named DCS workspace.",
        notes: Some(&["Without `--all`, only live top-level sessions are captured."]),
    },
    CommandHelp {
        name: "restore",
        usage: "restore <nameOrId> [--window new|current] [--dry-run]",
        description: "Restore a saved workspace by name or id.",
        notes: Some(&["Uses the workspace's recorded windows/tabs and session ids."]),
    },
    CommandHelp {
        name: "resume-repo",
        usage: "resume-repo <repository> [--window new|current] [--dry-run]",
        description: "Resume every open session whose repo/path matches the provided text.",
        notes: None,
    },
    CommandHelp {
        name: "restore-last",
        usage: "restore-last [--window new|current] [--dry-run]",
        description: "Restore the most recent auto-snapshot.",
        notes: Some(&["Create snapshots with `dcs snapshot` or the scheduled snapshot task."]),
    },
    CommandHelp {
        name: "snapshot",
        usage: "snapshot",
        description: "Capture a rolling auto-snapshot of the current open session layout.",
        notes: None,
    },
    CommandHelp {
        name: "restore-prompt",
        usage: "restore-prompt",
        description: "Logon helper: show the latest snapshot prompt or auto-restore based on config.",
        notes: Some(&["In prompt mode it opens `/restore-prompt` on the local API server."]),
    },
    CommandHelp {
        name: "ui",
        usage: "ui [--port n]",
        description: "Start or reuse the local Rust API server and open the restore prompt page.",
        notes: Some(&[
            "If the port is already in use, this command opens the existing local server URL instead of failing.",
            "The legacy React dashboard remains available through `npm run dev` from the repo.",
        ]),
    },
    CommandHelp {
        name: "serve",
        usage: "serve [--port n]",
        description: "Start the blocking Rust API server on localhost.",
        notes: Some(&[
            "Use this for API/TUI development.",
            "If the port is occupied, use `dcs ui` to reuse an existing DCS server or choose another port.",
        ]),
    },
    CommandHelp {
        name: "new",
        usage: "new <title> [--cwd dir] [--color color] [--prompt text] [--window new|current] [--dry-run]",
        description: "Launch a brand-new managed Copilot session in Windows Terminal.",
        notes: None,
    },
    CommandHelp {
        name: "clean",
        usage: "clean [--remove --confirm-copilot-state-write]",
        description: "Report stale Copilot lock files; optionally remove dead-PID locks.",
        notes: Some(&[
            "Default mode is read-only.",
            "Removal requires `--remove --confirm-copilot-state-write` as an explicit escape hatch.",
        ]),
    },
    CommandHelp {
        name: "stats",
        usage: "stats",
        description: "Show local usage/session statistics from readable Copilot session-store data.",
        notes: None,
    },
    CommandHelp {
        name: "transcript",
        usage: "transcript <sessionId> [-o|--out file]",
        description: "Print or export a session transcript when local transcript data exists.",
        notes: None,
    },
    CommandHelp {
        name: "logs",
        usage: "logs [--lines n] [--level level]",
        description: "Tail DCS-owned JSON log records.",
        notes: None,
    },
    CommandHelp {
        name: "export-workspaces",
        usage: "export-workspaces [file]",
        description: "Export saved workspaces as JSON to stdout or a file.",
        notes: None,
    },
    CommandHelp {
        name: "import-workspaces",
        usage: "import-workspaces <file> [--fresh-ids]",
        description: "Import workspaces from a DCS workspace export JSON file.",
        notes: Some(&["Use `--fresh-ids` to avoid replacing workspaces with matching ids."]),
    },
    CommandHelp {
        name: "diff",
        usage: "diff <workspace>",
        description: "Compare a saved workspace with the currently discovered session layout.",
        notes: None,
    },
    CommandHelp {
        name: "tray",
        usage: "tray",
        description: "Start the Windows system-tray helper with quick snapshot/restore actions.",
        notes: Some(&["The tray helper uses Windows PowerShell and Windows Forms NotifyIcon."]),
    },
    CommandHelp {
        name: "install-tasks",
        usage: "install-tasks [--interval minutes] [--no-hidden]",
        description: "Register scheduled snapshot and logon restore-prompt tasks.",
        notes: Some(&[
            "By default task actions run through hidden launcher scripts.",
            "If Windows denies the logon Scheduled Task, installs a current-user Startup-folder fallback.",
        ]),
    },
    CommandHelp {
        name: "uninstall-tasks",
        usage: "uninstall-tasks",
        description: "Remove DCS scheduled tasks and the current-user Startup fallback.",
        notes: None,
    },
    CommandHelp {
        name: "tasks-status",
        usage: "tasks-status",
        description: "Show whether DCS scheduled tasks and the Startup fallback are registered.",
        notes: None,
    },
    CommandHelp {
        name: "doctor",
        usage: "doctor [--json]",
        description: "Run environment checks for Windows Terminal, Copilot, Node, state dirs, and tasks.",
        notes: None,
    },
    CommandHelp {
        name: "help",
        usage: "help [command]",
        description: "Show command descriptions or detailed help for one command.",
        notes: None,
    },
];

fn print_help() {
    println!("Durable Copilot Sessions (Rust)\n");
    println!("Usage:");
    println!("  dcs <command> [options]");
    println!("  dcs help <command>\n");
    println!("Commands:");
    for command in COMMAND_HELP {
        println!("  {:<84} {}", command.usage, command.description);
    }
}

fn help_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let Some(name) = args.take_next() else {
        print_help();
        return Ok(());
    };
    print_command_help(&name)
}

fn print_command_help(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let Some(command) = COMMAND_HELP.iter().find(|command| command.name == name) else {
        return Err(format!("Unknown command: {name}").into());
    };
    println!("{}\n", command.name);
    println!("Usage:");
    println!("  dcs {}", command.usage);
    println!("\nWhat it does:");
    println!("  {}", command.description);
    if let Some(notes) = command.notes {
        println!("\nNotes:");
        for note in notes {
            println!("  - {note}");
        }
    }
    Ok(())
}

fn tab_count(workspace: &Workspace) -> usize {
    workspace
        .windows
        .iter()
        .map(|window| window.tabs.len())
        .sum()
}

fn required_arg(args: &mut Args, name: &str) -> Result<String, Box<dyn std::error::Error>> {
    args.take_next()
        .ok_or_else(|| format!("Missing required argument: {name}").into())
}

fn parse_window(value: Option<String>) -> Result<Option<WindowTarget>, Box<dyn std::error::Error>> {
    match value.as_deref() {
        None => Ok(None),
        Some("new") => Ok(Some(WindowTarget::New)),
        Some("current") => Ok(Some(WindowTarget::Current)),
        Some(other) => Err(format!("Invalid window target: {other}").into()),
    }
}

fn parse_memory_kind(
    value: Option<String>,
) -> Result<Option<MemoryKind>, Box<dyn std::error::Error>> {
    match value.as_deref() {
        None => Ok(None),
        Some("summary") => Ok(Some(MemoryKind::Summary)),
        Some("decision") => Ok(Some(MemoryKind::Decision)),
        Some("todo") => Ok(Some(MemoryKind::Todo)),
        Some("learning") => Ok(Some(MemoryKind::Learning)),
        Some("file_context") => Ok(Some(MemoryKind::FileContext)),
        Some("chat") => Ok(Some(MemoryKind::Chat)),
        Some(other) => Err(format!("Invalid memory kind: {other}").into()),
    }
}

fn absolute_path_string(value: &str) -> String {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_string_lossy().into_owned()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
            .to_string_lossy()
            .into_owned()
    }
}

fn resolve_cli_command(subcommand: &str) -> Result<String, Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    Ok(format!("\"{}\" {subcommand}", exe.to_string_lossy()))
}

#[derive(Debug)]
struct Args {
    values: Vec<String>,
}

impl Args {
    fn new(values: Vec<String>) -> Self {
        Self { values }
    }

    fn take_command(&mut self) -> Option<String> {
        self.take_next()
    }

    fn take_next(&mut self) -> Option<String> {
        if self.values.is_empty() {
            None
        } else {
            Some(self.values.remove(0))
        }
    }

    fn take_flag(&mut self, flag: &str) -> bool {
        if let Some(index) = self.values.iter().position(|value| value == flag) {
            self.values.remove(index);
            true
        } else {
            false
        }
    }

    fn take_option(&mut self, flag: &str) -> Option<String> {
        if let Some(index) = self.values.iter().position(|value| value == flag) {
            self.values.remove(index);
            if index < self.values.len() {
                Some(self.values.remove(index))
            } else {
                None
            }
        } else {
            let prefix = format!("{flag}=");
            self.values
                .iter()
                .position(|value| value.starts_with(&prefix))
                .map(|index| self.values.remove(index)[prefix.len()..].to_owned())
        }
    }

    fn has_help_flag(&self) -> bool {
        self.values
            .iter()
            .any(|value| value == "--help" || value == "-h")
    }

    fn remaining(self) -> Vec<String> {
        self.values
    }
}
