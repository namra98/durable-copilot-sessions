use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::model::{LaunchResult, ResumeOptions, TabSpec, WindowSpec, WindowTarget};

const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1";
const COPILOT_NOT_FOUND: &str =
    "copilot CLI was not found on PATH; the resumed tab may fail to start Copilot.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltTab {
    pub spec: TabSpec,
    pub script_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub args: Vec<Vec<String>>,
    pub result: LaunchResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchWindowsOptions {
    pub window: Option<WindowTarget>,
    pub copilot_command: Option<String>,
    pub copilot_args: Option<Vec<String>>,
    pub home_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSessionOptions {
    pub title: String,
    pub cwd: String,
    pub color: String,
    pub prompt: Option<String>,
    pub window: Option<WindowTarget>,
    pub copilot_command: Option<String>,
    pub copilot_args: Vec<String>,
}

#[derive(Debug)]
pub enum LaunchError {
    Io(io::Error),
    UnknownColor(String),
}

impl fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::UnknownColor(color) => write!(formatter, "Unknown color {color:?}"),
        }
    }
}

impl Error for LaunchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::UnknownColor(_) => None,
        }
    }
}

impl From<io::Error> for LaunchError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn render_launch_script(tab: &TabSpec, command: &str) -> String {
    let extra_args = tab.copilot_args.as_deref().unwrap_or_default();
    let mut invocation = vec![format!("& {}", single_quote(command))];
    invocation.extend(extra_args.iter().map(|arg| single_quote(arg)));
    invocation.push("'--resume'".into());
    invocation.push(single_quote(&tab.session_id));

    [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        "if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }".to_owned(),
        format!("Set-Location -LiteralPath {}", single_quote(&tab.cwd)),
        invocation.join(" "),
        String::new(),
    ]
    .join("\r\n")
}

pub fn render_new_session_script(
    cwd: &str,
    prompt: Option<&str>,
    command: &str,
    copilot_args: &[String],
) -> String {
    let mut invocation = vec![format!("& {}", single_quote(command))];
    invocation.extend(copilot_args.iter().map(|arg| single_quote(arg)));
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        invocation.push("'-i'".into());
        invocation.push(single_quote(prompt));
    }

    [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        "if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }".to_owned(),
        format!("Set-Location -LiteralPath {}", single_quote(cwd)),
        invocation.join(" "),
        String::new(),
    ]
    .join("\r\n")
}

pub fn write_launch_script(content: &str, dir: impl AsRef<Path>) -> Result<PathBuf, LaunchError> {
    let dir = dir.as_ref();
    fs::create_dir_all(dir)?;
    let file = dir.join(format!(
        "launch-{}-{}.ps1",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::write(&file, content)?;
    Ok(file)
}

pub fn build_window_args(
    target: WindowTarget,
    tabs: &[BuiltTab],
    shell: &str,
) -> Result<Vec<String>, LaunchError> {
    let mut args = vec![
        "-w".into(),
        match target {
            WindowTarget::Current => "0".into(),
            WindowTarget::New => "-1".into(),
        },
    ];

    for (index, tab) in tabs.iter().enumerate() {
        if index > 0 {
            args.push(";".into());
        }
        args.extend([
            "new-tab".into(),
            "--title".into(),
            escape_wt_value(&tab.spec.title),
            "--suppressApplicationTitle".into(),
            "--tabColor".into(),
            color_to_hex(&tab.spec.color)?,
            "-d".into(),
            escape_wt_value(&tab.spec.cwd),
            shell.into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-NoExit".into(),
            "-File".into(),
            escape_wt_value(&tab.script_path.to_string_lossy()),
        ]);
    }

    Ok(args)
}

pub fn plan_resume_session(
    opts: &ResumeOptions,
    script_dir: impl AsRef<Path>,
    home_dir: impl AsRef<Path>,
) -> Result<LaunchPlan, LaunchError> {
    let mut warnings = Vec::new();
    let resolved = resolve_launch_cwd(
        opts.cwd
            .as_deref()
            .unwrap_or(home_dir.as_ref().to_string_lossy().as_ref()),
        opts.fallbacks.as_deref().unwrap_or_default(),
        home_dir.as_ref(),
    );
    if let Some(warning) = resolved.warning {
        warnings.push(warning);
    }

    let tab = TabSpec {
        session_id: opts.session_id.clone(),
        title: opts
            .title
            .clone()
            .unwrap_or_else(|| opts.session_id.chars().take(8).collect()),
        color: opts.color.clone().unwrap_or_else(|| "blue".into()),
        cwd: resolved.cwd,
        copilot_args: opts.copilot_args.clone(),
    };
    let command = opts.copilot_command.as_deref().unwrap_or("copilot");
    let script_path = write_launch_script(&render_launch_script(&tab, command), script_dir)?;
    let built = BuiltTab {
        spec: tab,
        script_path,
    };
    let args = build_window_args(
        opts.window.unwrap_or(WindowTarget::New),
        &[built],
        "powershell.exe",
    )?;
    Ok(LaunchPlan {
        args: vec![args],
        result: LaunchResult {
            ok: true,
            tabs_launched: 1,
            windows_opened: 1,
            warnings,
            error: None,
        },
    })
}

pub fn plan_new_session(
    opts: &NewSessionOptions,
    script_dir: impl AsRef<Path>,
    home_dir: impl AsRef<Path>,
) -> Result<LaunchPlan, LaunchError> {
    let mut warnings = Vec::new();
    let resolved = resolve_launch_cwd(&opts.cwd, &[], home_dir.as_ref());
    if let Some(warning) = resolved.warning {
        warnings.push(warning);
    }
    let command = opts.copilot_command.as_deref().unwrap_or("copilot");
    let script_path = write_launch_script(
        &render_new_session_script(
            &resolved.cwd,
            opts.prompt.as_deref(),
            command,
            &opts.copilot_args,
        ),
        script_dir,
    )?;
    let built = BuiltTab {
        spec: TabSpec {
            session_id: "new".into(),
            title: opts.title.clone(),
            color: opts.color.clone(),
            cwd: resolved.cwd,
            copilot_args: None,
        },
        script_path,
    };
    let args = build_window_args(
        opts.window.unwrap_or(WindowTarget::New),
        &[built],
        "powershell.exe",
    )?;
    Ok(LaunchPlan {
        args: vec![args],
        result: LaunchResult {
            ok: true,
            tabs_launched: 1,
            windows_opened: 1,
            warnings,
            error: None,
        },
    })
}

pub fn plan_launch_windows(
    windows: &[WindowSpec],
    options: &LaunchWindowsOptions,
    script_dir: impl AsRef<Path>,
) -> Result<LaunchPlan, LaunchError> {
    let mut warnings = Vec::new();
    let mut args = Vec::new();
    let mut tabs_launched = 0;

    for (index, window) in windows.iter().enumerate() {
        let target = if index == 0 && options.window == Some(WindowTarget::Current) {
            WindowTarget::Current
        } else {
            WindowTarget::New
        };
        let mut built_tabs = Vec::new();
        for tab in &window.tabs {
            let resolved = resolve_launch_cwd(&tab.cwd, &[], &options.home_dir);
            if let Some(warning) = resolved.warning {
                warnings.push(warning);
            }

            let spec = TabSpec {
                cwd: resolved.cwd,
                copilot_args: options
                    .copilot_args
                    .clone()
                    .or_else(|| tab.copilot_args.clone()),
                ..tab.clone()
            };
            let command = options.copilot_command.as_deref().unwrap_or("copilot");
            let script_path =
                write_launch_script(&render_launch_script(&spec, command), script_dir.as_ref())?;
            built_tabs.push(BuiltTab { spec, script_path });
        }
        tabs_launched += built_tabs.len() as u32;
        args.push(build_window_args(target, &built_tabs, "powershell.exe")?);
    }

    Ok(LaunchPlan {
        args,
        result: LaunchResult {
            ok: true,
            tabs_launched,
            windows_opened: windows.len() as u32,
            warnings,
            error: None,
        },
    })
}

pub fn execute_launch_plan(plan: LaunchPlan, dry_run: bool) -> LaunchResult {
    if dry_run {
        return plan.result;
    }
    for args in &plan.args {
        match std::process::Command::new("wt").args(args).status() {
            Ok(status) if status.success() => {}
            Ok(status) => {
                return LaunchResult {
                    ok: false,
                    tabs_launched: 0,
                    windows_opened: 0,
                    warnings: plan.result.warnings,
                    error: Some(format!("wt.exe exited with status {status}")),
                };
            }
            Err(error) => {
                return LaunchResult {
                    ok: false,
                    tabs_launched: 0,
                    windows_opened: 0,
                    warnings: plan.result.warnings,
                    error: Some(error.to_string()),
                };
            }
        }
    }
    plan.result
}

pub fn preflight<F>(resolve: F) -> (bool, Vec<String>)
where
    F: Fn(&str) -> Option<String>,
{
    let mut missing = Vec::new();
    if resolve("wt").is_none() {
        missing.push("wt".into());
    }
    if resolve("copilot").is_none() {
        missing.push("copilot".into());
    }
    (missing.is_empty(), missing)
}

pub fn pick_shell<F>(resolve: F) -> &'static str
where
    F: Fn(&str) -> Option<String>,
{
    if resolve("pwsh").is_some() {
        "pwsh.exe"
    } else {
        "powershell.exe"
    }
}

pub fn copilot_missing_warning<F>(resolve: F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    resolve("copilot")
        .is_none()
        .then(|| COPILOT_NOT_FOUND.into())
}

pub fn resolve_executable_in_path(
    name: &str,
    path_value: &str,
    pathext: Option<&str>,
) -> Option<PathBuf> {
    let has_ext = Path::new(name).extension().is_some();
    let extensions: Vec<&str> = pathext.unwrap_or(DEFAULT_PATHEXT).split(';').collect();
    let candidates: Vec<String> = if has_ext {
        vec![name.into()]
    } else {
        extensions
            .iter()
            .filter(|extension| !extension.is_empty())
            .map(|extension| format!("{name}{extension}"))
            .chain(std::iter::once(name.into()))
            .collect()
    };

    for dir in path_value.split(';').filter(|entry| !entry.is_empty()) {
        for candidate in &candidates {
            let full = Path::new(dir).join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

pub fn resolve_launch_cwd(cwd: &str, fallbacks: &[String], home_dir: &Path) -> ResolvedCwd {
    if !cwd.is_empty() && Path::new(cwd).exists() {
        return ResolvedCwd {
            cwd: cwd.into(),
            warning: None,
        };
    }

    for fallback in fallbacks {
        if !fallback.is_empty() && Path::new(fallback).exists() {
            return ResolvedCwd {
                cwd: fallback.clone(),
                warning: Some(format!(
                    "cwd {cwd:?} does not exist; launching in {fallback:?} instead."
                )),
            };
        }
    }

    let home = home_dir.to_string_lossy().into_owned();
    ResolvedCwd {
        cwd: home.clone(),
        warning: Some(format!(
            "cwd {cwd:?} does not exist; launching in home directory {home:?} instead."
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCwd {
    pub cwd: String,
    pub warning: Option<String>,
}

pub fn escape_wt_value(value: &str) -> String {
    value.replace(';', "\\;")
}

pub fn color_to_hex(color: &str) -> Result<String, LaunchError> {
    let trimmed = color.trim();
    if trimmed.len() == 6 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Ok(format!("#{trimmed}").to_ascii_uppercase());
    }
    if trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed[1..].chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Ok(trimmed.to_ascii_uppercase());
    }
    let map = color_map();
    map.get(&trimmed.to_ascii_lowercase())
        .cloned()
        .ok_or_else(|| LaunchError::UnknownColor(color.into()))
}

fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn color_map() -> BTreeMap<String, String> {
    [
        ("black", "#000000"),
        ("white", "#FFFFFF"),
        ("red", "#FF0000"),
        ("green", "#00FF00"),
        ("blue", "#0000FF"),
        ("yellow", "#FFFF00"),
        ("orange", "#FFA500"),
        ("purple", "#800080"),
        ("violet", "#EE82EE"),
        ("pink", "#FFC0CB"),
        ("magenta", "#FF00FF"),
        ("fuchsia", "#FF00FF"),
        ("cyan", "#00FFFF"),
        ("aqua", "#00FFFF"),
        ("teal", "#008080"),
        ("gray", "#808080"),
        ("grey", "#808080"),
        ("silver", "#C0C0C0"),
        ("maroon", "#800000"),
        ("olive", "#808000"),
        ("navy", "#000080"),
        ("lime", "#00FF00"),
        ("brown", "#A52A2A"),
        ("gold", "#FFD700"),
        ("amber", "#FFBF00"),
        ("indigo", "#4B0082"),
        ("crimson", "#DC143C"),
        ("slate", "#708090"),
        ("dark-green", "#008000"),
        ("light-green", "#90EE90"),
        ("dark-blue", "#00008B"),
        ("light-blue", "#ADD8E6"),
        ("dark-red", "#8B0000"),
        ("bright-red", "#FF0000"),
        ("bright-green", "#00FF00"),
        ("bright-blue", "#0000FF"),
    ]
    .into_iter()
    .map(|(name, value)| (name.into(), value.into()))
    .collect()
}
