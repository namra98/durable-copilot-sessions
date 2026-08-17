use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model::LogRecord;

pub fn tail_logs(
    dir: impl AsRef<Path>,
    lines: Option<usize>,
    level: Option<&str>,
) -> Vec<LogRecord> {
    let lines = lines.unwrap_or(200);
    if lines == 0 {
        return Vec::new();
    }
    let min_rank = level.and_then(level_rank);
    let mut files = list_log_files(dir.as_ref());
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut chunks = Vec::new();
    let mut total = 0usize;
    for (_, path) in files.into_iter().take(2) {
        let records = parse_log_file(&path);
        total += records.len();
        chunks.push(records);
        if total >= lines {
            break;
        }
    }
    chunks.reverse();
    let mut all = chunks.into_iter().flatten().collect::<Vec<_>>();
    if let Some(min_rank) = min_rank {
        all.retain(|record| {
            record
                .level
                .as_deref()
                .and_then(level_rank)
                .map(|rank| rank >= min_rank)
                .unwrap_or(false)
        });
    }
    all.into_iter().skip(total.saturating_sub(lines)).collect()
}

fn list_log_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let date = name.strip_prefix("api-")?.strip_suffix(".log")?.to_owned();
            (is_iso_date(&date)).then_some((date, entry.path()))
        })
        .collect()
}

fn parse_log_file(path: &Path) -> Vec<LogRecord> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter_map(|value| {
            let Value::Object(mut object) = value else {
                return None;
            };
            Some(LogRecord {
                ts: take_string(&mut object, "ts"),
                level: take_string(&mut object, "level"),
                message: take_string(&mut object, "message"),
                scope: take_string(&mut object, "scope"),
                extra: object.into_iter().collect::<BTreeMap<_, _>>(),
            })
        })
        .collect()
}

fn take_string(object: &mut serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object.remove(key).and_then(|value| match value {
        Value::String(value) if !value.is_empty() => Some(value),
        _ => None,
    })
}

fn level_rank(level: &str) -> Option<u8> {
    match level.to_ascii_lowercase().as_str() {
        "debug" => Some(10),
        "info" => Some(20),
        "warn" => Some(30),
        "error" => Some(40),
        _ => None,
    }
}

fn is_iso_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}
