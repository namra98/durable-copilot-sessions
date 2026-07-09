use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
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
    install_tasks, run_schtasks, tasks_status, uninstall_tasks, write_hidden_launcher,
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
    match command.as_deref() {
        None | Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some("--version") | Some("-V") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("serve") => serve_command(args).await,
        Some("ui") => serve_command(args).await,
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

async fn serve_command(mut args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let paths = DcsPaths::from_env();
    let config = load_config(&paths.config_file);
    let port = args
        .take_option("--port")
        .or_else(|| args.take_next())
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(config.api_port);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    println!("API listening: http://{addr}/api  (Ctrl+C to stop)");
    dcs_rs::server::serve(dcs_rs::server::ServerOptions { addr, paths }).await
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
    if config.auto_open_browser {
        open_local_url_after_delay(url.clone());
    }
    serve_on(paths, config.api_port, Some(&url)).await
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
        restore_inner
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
    Ok(())
}

fn uninstall_tasks_command() -> Result<(), Box<dyn std::error::Error>> {
    for message in uninstall_tasks(run_schtasks).messages {
        println!("{message}");
    }
    Ok(())
}

fn tasks_status_command() -> Result<(), Box<dyn std::error::Error>> {
    let status = tasks_status(run_schtasks);
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

async fn serve_on(
    paths: DcsPaths,
    port: u16,
    url: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    println!(
        "Open {} to review and restore.",
        url.map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("http://{addr}"))
    );
    dcs_rs::server::serve(dcs_rs::server::ServerOptions { addr, paths }).await
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

fn print_help() {
    println!(
        "Durable Copilot Sessions (Rust)\n\nCommands:\n  list [--live|--all] [--tree]\n  resume <sessionId> [--window new|current] [--color color] [--title title] [--dry-run]\n  fork <sessionId> [--note text] [--launch] [--color color] [--window new|current] [--dry-run] --confirm-copilot-state-write\n  recall <query...> [--repo repository] [--kind kind] [--limit n]\n  reindex-memory\n  save <name> [--all] [--description text]\n  restore <nameOrId> [--window new|current] [--dry-run]\n  resume-repo <repository> [--window new|current] [--dry-run]\n  restore-last [--window new|current] [--dry-run]\n  snapshot\n  restore-prompt\n  ui [--port n]\n  serve [--port n]\n  new <title> [--cwd dir] [--color color] [--prompt text] [--window new|current] [--dry-run]\n  clean [--remove --confirm-copilot-state-write]\n  stats\n  transcript <sessionId> [-o|--out file]\n  logs [--lines n] [--level level]\n  export-workspaces [file]\n  import-workspaces <file> [--fresh-ids]\n  diff <workspace>\n  tray\n  install-tasks [--interval minutes] [--no-hidden]\n  uninstall-tasks\n  tasks-status\n  doctor [--json]"
    );
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

    fn remaining(self) -> Vec<String> {
        self.values
    }
}
