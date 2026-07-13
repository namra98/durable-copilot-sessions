use std::path::Path;

use rusqlite::{Connection, OpenFlags, Row};
use time::{Duration, OffsetDateTime};

use crate::model::{StatsActivity, StatsRepo, StatsReport};

const ACTIVITY_WINDOW_DAYS: i64 = 30;
const TOP_REPOS_LIMIT: u32 = 15;

pub fn compute_stats(source_db: impl AsRef<Path>) -> StatsReport {
    let generated_at = now_iso();
    compute_stats_with_generated_at(source_db, &generated_at)
}

pub fn compute_stats_with_generated_at(
    source_db: impl AsRef<Path>,
    generated_at: &str,
) -> StatsReport {
    let end_iso_date = generated_at.get(0..10).unwrap_or(generated_at);
    let empty = empty_report(generated_at, end_iso_date);
    if !source_db.as_ref().exists() {
        return empty;
    }

    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = match Connection::open_with_flags(source_db, flags) {
        Ok(db) => db,
        Err(_) => return empty,
    };

    StatsReport {
        total_sessions: count_table(&db, "sessions"),
        total_checkpoints: count_table(&db, "checkpoints"),
        total_turns: count_table(&db, "turns"),
        top_repos: top_repositories(&db),
        activity_by_day: activity_by_day(&db, end_iso_date),
        generated_at: generated_at.into(),
    }
}

fn empty_report(generated_at: &str, end_iso_date: &str) -> StatsReport {
    StatsReport {
        total_sessions: 0,
        total_checkpoints: 0,
        total_turns: 0,
        top_repos: Vec::new(),
        activity_by_day: build_activity_window(&[], end_iso_date),
        generated_at: generated_at.into(),
    }
}

fn count_table(db: &Connection, table: &str) -> u32 {
    let sql = format!("SELECT COUNT(*) AS n FROM {table}");
    db.query_row(&sql, [], |row| scalar_count(row, 0))
        .unwrap_or(0)
}

fn top_repositories(db: &Connection) -> Vec<StatsRepo> {
    let mut stmt = match db.prepare(
        "SELECT repository AS repository, COUNT(*) AS sessions
           FROM sessions
          WHERE repository IS NOT NULL AND TRIM(repository) <> ''
          GROUP BY repository
          ORDER BY sessions DESC, repository ASC
          LIMIT ?1",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map([TOP_REPOS_LIMIT], |row| {
        Ok((scalar_string(row, 0), scalar_count(row, 1)?))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    rows.filter_map(Result::ok)
        .filter_map(|(repository, sessions)| {
            repository
                .filter(|value| !value.is_empty())
                .filter(|_| sessions > 0)
                .map(|repository| StatsRepo {
                    repository,
                    sessions,
                })
        })
        .collect()
}

fn activity_by_day(db: &Connection, end_iso_date: &str) -> Vec<StatsActivity> {
    let mut counts: Vec<(String, u32)> = Vec::new();
    let mut stmt = match db.prepare("SELECT updated_at AS updated_at FROM sessions") {
        Ok(stmt) => stmt,
        Err(_) => return build_activity_window(&counts, end_iso_date),
    };

    if let Ok(rows) = stmt.query_map([], |row| Ok(scalar_json_string(row, 0))) {
        for value in rows.flatten().flatten() {
            if let Some(date) = to_iso_date(&value) {
                if let Some((_, count)) = counts.iter_mut().find(|(day, _)| day == &date) {
                    *count = count.saturating_add(1);
                } else {
                    counts.push((date, 1));
                }
            }
        }
    }

    build_activity_window(&counts, end_iso_date)
}

fn build_activity_window(counts: &[(String, u32)], end_iso_date: &str) -> Vec<StatsActivity> {
    let end = parse_date(end_iso_date).unwrap_or_else(|| OffsetDateTime::now_utc().date());
    let mut out = Vec::with_capacity(ACTIVITY_WINDOW_DAYS as usize);
    for offset in (0..ACTIVITY_WINDOW_DAYS).rev() {
        let date = end - Duration::days(offset);
        let key = date.to_string();
        let sessions = counts
            .iter()
            .find_map(|(day, count)| (day == &key).then_some(*count))
            .unwrap_or(0);
        out.push(StatsActivity {
            date: key,
            sessions,
        });
    }
    out
}

fn scalar_count(row: &Row<'_>, index: usize) -> rusqlite::Result<u32> {
    let value: rusqlite::types::Value = row.get(index)?;
    Ok(as_count(&value))
}

fn scalar_string(row: &Row<'_>, index: usize) -> Option<String> {
    let value: rusqlite::types::Value = row.get(index).ok()?;
    as_string(&value)
}

fn scalar_json_string(row: &Row<'_>, index: usize) -> Option<String> {
    let value: rusqlite::types::Value = row.get(index).ok()?;
    match value {
        rusqlite::types::Value::Integer(value) => Some(value.to_string()),
        rusqlite::types::Value::Real(value) => Some(value.to_string()),
        rusqlite::types::Value::Text(value) => Some(value),
        _ => None,
    }
}

fn as_count(value: &rusqlite::types::Value) -> u32 {
    match value {
        rusqlite::types::Value::Integer(value) => {
            u32::try_from((*value).max(0)).unwrap_or(u32::MAX)
        }
        rusqlite::types::Value::Real(value) if value.is_finite() && *value > 0.0 => {
            (*value as u64).min(u32::MAX as u64) as u32
        }
        rusqlite::types::Value::Text(value) => value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| (value as u64).min(u32::MAX as u64) as u32)
            .unwrap_or(0),
        _ => 0,
    }
}

fn as_string(value: &rusqlite::types::Value) -> Option<String> {
    match value {
        rusqlite::types::Value::Text(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.into())
        }
        rusqlite::types::Value::Integer(value) => Some(value.to_string()),
        rusqlite::types::Value::Real(value) if value.is_finite() => Some(value.to_string()),
        _ => None,
    }
}

fn to_iso_date(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() >= 10 && is_iso_date_prefix(&trimmed[0..10]) {
        return Some(trimmed[0..10].into());
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return trimmed.parse::<f64>().ok().and_then(epoch_to_iso_date);
    }
    OffsetDateTime::parse(trimmed, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|value| value.date().to_string())
}

fn epoch_to_iso_date(value: f64) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let millis = if value < 1_000_000_000_000.0 {
        (value * 1000.0).round() as i128
    } else {
        value.round() as i128
    };
    let seconds = i64::try_from(millis / 1000).ok()?;
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .map(|value| value.date().to_string())
}

fn parse_date(value: &str) -> Option<time::Date> {
    let mut parts = value.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u8>().ok()?;
    let day = parts.next()?.parse::<u8>().ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()
}

fn is_iso_date_prefix(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn now_iso() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}
