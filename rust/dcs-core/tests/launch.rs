use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dcs_core::launch::{
    build_window_args, color_to_hex, escape_wt_value, pick_shell, plan_launch_windows,
    plan_resume_session, preflight, render_launch_script, render_new_session_script,
    resolve_executable_in_path, resolve_launch_cwd, BuiltTab, LaunchWindowsOptions,
};
use dcs_core::model::{ResumeOptions, TabSpec, WindowSpec, WindowTarget};

fn temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("dcs-rust-launch-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn tab(id: &str, cwd: &str) -> TabSpec {
    TabSpec {
        session_id: id.into(),
        title: format!("tab-{id}"),
        color: "green".into(),
        cwd: cwd.into(),
        copilot_args: None,
    }
}

#[test]
fn normalizes_windows_terminal_colors() {
    assert_eq!(color_to_hex("blue").unwrap(), "#0000FF");
    assert_eq!(color_to_hex("#00ff00").unwrap(), "#00FF00");
    assert_eq!(color_to_hex("ee82ee").unwrap(), "#EE82EE");
    assert!(color_to_hex("not-a-color").is_err());
}

#[test]
fn renders_resume_and_new_session_powershell_scripts() {
    let mut base = tab("11112222-3333-4444", r"C:\work\repo");
    base.copilot_args = Some(vec!["--allow-all-tools".into()]);
    let script = render_launch_script(&base, "copilot");

    assert!(script.contains("Set-Location -LiteralPath 'C:\\work\\repo'"));
    assert!(script.contains("'--resume' '11112222-3333-4444'"));
    assert!(script.contains("'--allow-all-tools'"));

    base.cwd = r"C:\o'brien".into();
    assert!(render_launch_script(&base, "copilot").contains("C:\\o''brien"));

    let new_script = render_new_session_script(
        r"C:\work\repo",
        Some("hello agent"),
        "agency",
        &["copilot".into(), "--yolo".into()],
    );
    assert!(new_script.contains("& 'agency' 'copilot' '--yolo' '-i' 'hello agent'"));
}

#[test]
fn builds_wt_args_with_separators_and_execution_policy() {
    let built = vec![
        BuiltTab {
            spec: tab("a", r"C:\x"),
            script_path: PathBuf::from(r"C:\scripts\a.ps1"),
        },
        BuiltTab {
            spec: tab("b", r"C:\x"),
            script_path: PathBuf::from(r"C:\scripts\b.ps1"),
        },
    ];
    let args = build_window_args(WindowTarget::New, &built, "powershell.exe").unwrap();

    assert_eq!(&args[0..2], ["-w", "-1"]);
    assert_eq!(args.iter().filter(|arg| *arg == "new-tab").count(), 2);
    assert!(args.contains(&";".into()));
    assert!(args.contains(&"-ExecutionPolicy".into()));
    assert!(args.contains(&"Bypass".into()));
    assert_eq!(escape_wt_value("a;b"), "a\\;b");

    let current = build_window_args(WindowTarget::Current, &built[0..1], "powershell.exe").unwrap();
    assert_eq!(&current[0..2], ["-w", "0"]);
}

#[test]
fn resolves_launch_cwd_with_fallback_and_home_warnings() {
    let home = temp_dir();
    let fallback = temp_dir();
    let resolved = resolve_launch_cwd(
        r"C:\missing",
        &[fallback.to_string_lossy().into_owned()],
        &home,
    );

    assert_eq!(Path::new(&resolved.cwd), fallback.as_path());
    assert!(resolved.warning.unwrap().contains("does not exist"));

    let home_resolved = resolve_launch_cwd(r"C:\missing", &[], &home);
    assert_eq!(Path::new(&home_resolved.cwd), home.as_path());

    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(fallback).unwrap();
}

#[test]
fn plans_resume_and_window_launches_without_executing_wt() {
    let home = temp_dir();
    let scripts = temp_dir();
    let plan = plan_resume_session(
        &ResumeOptions {
            session_id: "dryrun-session".into(),
            title: None,
            color: None,
            cwd: Some(home.to_string_lossy().into_owned()),
            fallbacks: None,
            window: Some(WindowTarget::Current),
            copilot_args: None,
            copilot_command: None,
            dry_run: Some(true),
        },
        &scripts,
        &home,
    )
    .unwrap();

    assert!(plan.result.ok);
    assert_eq!(plan.result.tabs_launched, 1);
    assert_eq!(&plan.args[0][0..2], ["-w", "0"]);

    let windows = vec![
        WindowSpec {
            id: "w1".into(),
            label: None,
            tabs: vec![tab("s1", &home.to_string_lossy())],
        },
        WindowSpec {
            id: "w2".into(),
            label: None,
            tabs: vec![tab("s2", &home.to_string_lossy())],
        },
    ];
    let window_plan = plan_launch_windows(
        &windows,
        &LaunchWindowsOptions {
            window: Some(WindowTarget::Current),
            copilot_command: None,
            copilot_args: Some(vec!["--allow-all-tools".into()]),
            home_dir: home.clone(),
        },
        &scripts,
    )
    .unwrap();
    assert_eq!(window_plan.args.len(), 2);
    assert_eq!(window_plan.result.windows_opened, 2);
    assert_eq!(window_plan.result.tabs_launched, 2);
    assert_eq!(&window_plan.args[0][0..2], ["-w", "0"]);
    assert_eq!(&window_plan.args[1][0..2], ["-w", "-1"]);

    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(scripts).unwrap();
}

#[test]
fn resolves_executables_with_pathext_and_reports_preflight() {
    let dir = temp_dir();
    let shim = dir.join("copilot.cmd");
    fs::write(&shim, "@echo off").unwrap();
    let resolved =
        resolve_executable_in_path("copilot", &dir.to_string_lossy(), Some(".EXE;.CMD")).unwrap();
    assert_eq!(
        resolved.to_string_lossy().to_ascii_lowercase(),
        shim.to_string_lossy().to_ascii_lowercase()
    );

    assert!(resolve_executable_in_path("copilot", &dir.to_string_lossy(), Some(".EXE")).is_none());
    assert_eq!(
        preflight(|name| Some(format!(r"C:\{name}.exe"))),
        (true, vec![])
    );
    assert_eq!(
        preflight(|name| (name == "wt").then(|| r"C:\wt.exe".into())),
        (false, vec!["copilot".into()])
    );
    assert_eq!(
        pick_shell(|name| (name == "pwsh").then(|| r"C:\pwsh.exe".into())),
        "pwsh.exe"
    );
    assert_eq!(pick_shell(|_| None), "powershell.exe");

    fs::remove_dir_all(dir).unwrap();
}
