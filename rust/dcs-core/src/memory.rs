use std::collections::{BTreeSet, HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{params, Connection, OpenFlags, Row};
use sha1::{Digest, Sha1};

use crate::model::{Memory, MemoryKind, MemoryRecallPack, MemorySearchHit};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT,
  title TEXT,
  content TEXT,
  repository TEXT,
  branch TEXT,
  cwd TEXT,
  source_table TEXT,
  source_ref TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repository);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  content,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO memories_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
"#;

#[derive(Debug)]
pub enum MemoryError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for MemoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Sqlite(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for MemoryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
        }
    }
}

impl From<std::io::Error> for MemoryError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for MemoryError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Debug, Clone, Default)]
struct ParentMeta {
    repository: Option<String>,
    branch: Option<String>,
    cwd: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Default)]
struct SessionRow {
    id: Option<String>,
    cwd: Option<String>,
    repository: Option<String>,
    branch: Option<String>,
    summary: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Default)]
struct CheckpointRow {
    id: Option<String>,
    session_id: Option<String>,
    title: Option<String>,
    overview: Option<String>,
    work_done: Option<String>,
    technical_details: Option<String>,
    important_files: Option<String>,
    next_steps: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Default)]
struct TurnRow {
    session_id: Option<String>,
    turn_index: Option<String>,
    user_message: Option<String>,
    assistant_response: Option<String>,
    timestamp: u64,
}

pub fn extract_memories(source_db: impl AsRef<Path>) -> Vec<Memory> {
    if !source_db.as_ref().exists() {
        return Vec::new();
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = match Connection::open_with_flags(source_db, flags) {
        Ok(db) => db,
        Err(_) => return Vec::new(),
    };

    let session_rows = read_sessions(&db);
    let parents = build_parent_index(&session_rows);
    let mut memories = Vec::new();

    for checkpoint in read_checkpoints(&db) {
        memories.extend(memories_from_checkpoint(&checkpoint, &parents));
    }
    for session in &session_rows {
        if let Some(memory) = memory_from_session(session) {
            memories.push(memory);
        }
    }
    for turn in read_turns(&db) {
        if let Some(memory) = memory_from_turn(&turn, &parents) {
            memories.push(memory);
        }
    }

    memories
}

pub struct SqliteMemoryStore {
    db: Connection,
}

impl SqliteMemoryStore {
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, MemoryError> {
        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let db = Connection::open(db_path)?;
        db.execute_batch("PRAGMA journal_mode=WAL;")?;
        db.execute_batch(SCHEMA)?;
        Ok(Self { db })
    }

    pub fn reindex(&mut self, source_db: impl AsRef<Path>) -> Result<u32, MemoryError> {
        let memories = extract_memories(source_db);
        let tx = self.db.transaction()?;
        {
            let mut upsert = tx.prepare(
                "INSERT OR REPLACE INTO memories
                   (id, session_id, kind, title, content, repository, branch, cwd,
                    source_table, source_ref, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?;
            for memory in &memories {
                upsert.execute(params![
                    memory.id,
                    memory.session_id,
                    kind_to_str(memory.kind),
                    memory.title,
                    memory.content,
                    memory.repository,
                    memory.branch,
                    memory.cwd,
                    memory.source_table,
                    memory.source_ref,
                    i64::try_from(memory.created_at).unwrap_or(i64::MAX),
                    i64::try_from(memory.updated_at).unwrap_or(i64::MAX),
                ])?;
            }
        }
        tx.commit()?;
        let _ = self
            .db
            .execute_batch("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
        Ok(memories.len().min(u32::MAX as usize) as u32)
    }

    pub fn search(
        &self,
        query: &str,
        repository: Option<&str>,
        kind: Option<MemoryKind>,
        limit: Option<u32>,
    ) -> Vec<MemorySearchHit> {
        if let Some(prefix) = session_id_prefix(query) {
            let rows = self
                .query_memories(
                    "SELECT * FROM memories WHERE lower(session_id) LIKE ?1 ORDER BY updated_at DESC LIMIT ?2",
                    params![format!("{prefix}%"), limit.unwrap_or(20)],
                )
                .unwrap_or_default();
            if !rows.is_empty() {
                return rows
                    .into_iter()
                    .map(|memory| MemorySearchHit {
                        memory,
                        score: 0.0,
                        snippet: None,
                    })
                    .collect();
            }
        }

        let Some(match_query) = sanitize_fts_query(query) else {
            return self.recent_filtered(repository, kind, limit);
        };

        let mut sql = String::from(
            "SELECT m.*, bm25(memories_fts) AS bm,
                    snippet(memories_fts, 1, '[', ']', '...', 12) AS snip
               FROM memories_fts
               JOIN memories m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ?1",
        );
        let limit = limit.unwrap_or(20);
        match (repository, kind) {
            (Some(repository), Some(kind)) => {
                sql.push_str(
                    " AND m.repository = ?2 AND m.kind = ?3 ORDER BY bm25(memories_fts) LIMIT ?4",
                );
                self.query_hits(
                    &sql,
                    params![match_query, repository, kind_to_str(kind), limit],
                )
            }
            (Some(repository), None) => {
                sql.push_str(" AND m.repository = ?2 ORDER BY bm25(memories_fts) LIMIT ?3");
                self.query_hits(&sql, params![match_query, repository, limit])
            }
            (None, Some(kind)) => {
                sql.push_str(" AND m.kind = ?2 ORDER BY bm25(memories_fts) LIMIT ?3");
                self.query_hits(&sql, params![match_query, kind_to_str(kind), limit])
            }
            (None, None) => {
                sql.push_str(" ORDER BY bm25(memories_fts) LIMIT ?2");
                self.query_hits(&sql, params![match_query, limit])
            }
        }
        .unwrap_or_else(|_| self.recent_filtered(repository, kind, Some(limit)))
    }

    pub fn related(&self, session_id: &str, limit: Option<u32>) -> Vec<Memory> {
        let mut repos = BTreeSet::new();
        let Ok(mut stmt) = self.db.prepare(
            "SELECT DISTINCT repository FROM memories WHERE session_id = ?1 AND repository IS NOT NULL",
        ) else {
            return Vec::new();
        };
        if let Ok(rows) = stmt.query_map([session_id], |row| Ok(value_str(row, "repository"))) {
            for repo in rows.flatten().flatten() {
                if !repo.is_empty() {
                    repos.insert(repo);
                }
            }
        }
        if repos.is_empty() {
            return Vec::new();
        }

        let placeholders = (0..repos.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT * FROM memories WHERE session_id != ? AND repository IN ({placeholders}) ORDER BY updated_at DESC LIMIT ?"
        );
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(session_id.to_owned())];
        values.extend(
            repos
                .into_iter()
                .map(|repo| Box::new(repo) as Box<dyn rusqlite::ToSql>),
        );
        values.push(Box::new(limit.unwrap_or(20)));
        let refs = values
            .iter()
            .map(|value| value.as_ref())
            .collect::<Vec<&dyn rusqlite::ToSql>>();
        self.query_memories(&sql, refs.as_slice())
            .unwrap_or_default()
    }

    pub fn recall(
        &self,
        repository: Option<&str>,
        branch: Option<&str>,
        limit: Option<u32>,
    ) -> MemoryRecallPack {
        let cap = limit.unwrap_or(10);
        let decisions = self.recall_by_kind(MemoryKind::Decision, repository, branch, cap);
        let todos = self.recall_by_kind(MemoryKind::Todo, repository, branch, cap);
        let summaries = self.recall_by_kind(MemoryKind::Summary, repository, branch, cap);
        let file_memories = self.recall_by_kind(
            MemoryKind::FileContext,
            repository,
            branch,
            cap.saturating_mul(2),
        );
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for memory in file_memories {
            for line in memory.content.lines() {
                let file = line.trim();
                if !file.is_empty() && seen.insert(file.to_owned()) {
                    files.push(file.to_owned());
                }
            }
        }

        MemoryRecallPack {
            repository: repository.map(ToOwned::to_owned),
            branch: branch.map(ToOwned::to_owned),
            decisions,
            todos,
            summaries,
            files,
        }
    }

    pub fn list_for_session(&self, session_id: &str) -> Vec<Memory> {
        self.query_memories(
            "SELECT * FROM memories WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
            [session_id],
        )
        .unwrap_or_default()
    }

    pub fn count(&self) -> u32 {
        self.db
            .query_row("SELECT COUNT(*) AS n FROM memories", [], |row| {
                let n: i64 = row.get(0)?;
                Ok(u32::try_from(n.max(0)).unwrap_or(u32::MAX))
            })
            .unwrap_or(0)
    }

    fn recall_by_kind(
        &self,
        kind: MemoryKind,
        repository: Option<&str>,
        branch: Option<&str>,
        limit: u32,
    ) -> Vec<Memory> {
        match (repository, branch) {
            (Some(repository), Some(branch)) => self.query_memories(
                "SELECT * FROM memories WHERE kind = ?1 AND repository = ?2 AND branch = ?3 ORDER BY updated_at DESC LIMIT ?4",
                params![kind_to_str(kind), repository, branch, limit],
            ),
            (Some(repository), None) => self.query_memories(
                "SELECT * FROM memories WHERE kind = ?1 AND repository = ?2 ORDER BY updated_at DESC LIMIT ?3",
                params![kind_to_str(kind), repository, limit],
            ),
            (None, Some(branch)) => self.query_memories(
                "SELECT * FROM memories WHERE kind = ?1 AND branch = ?2 ORDER BY updated_at DESC LIMIT ?3",
                params![kind_to_str(kind), branch, limit],
            ),
            (None, None) => self.query_memories(
                "SELECT * FROM memories WHERE kind = ?1 ORDER BY updated_at DESC LIMIT ?2",
                params![kind_to_str(kind), limit],
            ),
        }
        .unwrap_or_default()
    }

    fn recent_filtered(
        &self,
        repository: Option<&str>,
        kind: Option<MemoryKind>,
        limit: Option<u32>,
    ) -> Vec<MemorySearchHit> {
        let memories = match (repository, kind) {
            (Some(repository), Some(kind)) => self.query_memories(
                "SELECT * FROM memories WHERE repository = ?1 AND kind = ?2 ORDER BY updated_at DESC LIMIT ?3",
                params![repository, kind_to_str(kind), limit.unwrap_or(20)],
            ),
            (Some(repository), None) => self.query_memories(
                "SELECT * FROM memories WHERE repository = ?1 ORDER BY updated_at DESC LIMIT ?2",
                params![repository, limit.unwrap_or(20)],
            ),
            (None, Some(kind)) => self.query_memories(
                "SELECT * FROM memories WHERE kind = ?1 ORDER BY updated_at DESC LIMIT ?2",
                params![kind_to_str(kind), limit.unwrap_or(20)],
            ),
            (None, None) => self.query_memories(
                "SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?1",
                params![limit.unwrap_or(20)],
            ),
        }
        .unwrap_or_default();
        memories
            .into_iter()
            .map(|memory| MemorySearchHit {
                memory,
                score: 0.0,
                snippet: None,
            })
            .collect()
    }

    fn query_hits<P>(&self, sql: &str, params: P) -> rusqlite::Result<Vec<MemorySearchHit>>
    where
        P: rusqlite::Params,
    {
        let mut stmt = self.db.prepare(sql)?;
        let rows = stmt.query_map(params, |row| {
            let memory = row_to_memory(row)?;
            let bm = row.get::<_, f64>("bm").unwrap_or(0.0);
            Ok(MemorySearchHit {
                memory,
                score: -bm,
                snippet: value_str(row, "snip"),
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn query_memories<P>(&self, sql: &str, params: P) -> rusqlite::Result<Vec<Memory>>
    where
        P: rusqlite::Params,
    {
        let mut stmt = self.db.prepare(sql)?;
        let rows = stmt.query_map(params, row_to_memory)?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

fn read_sessions(db: &Connection) -> Vec<SessionRow> {
    query_rows(db, "SELECT * FROM sessions", |row| SessionRow {
        id: value_str(row, "id"),
        cwd: value_str(row, "cwd"),
        repository: value_str(row, "repository"),
        branch: value_str(row, "branch"),
        summary: value_str(row, "summary"),
        created_at: value_millis(row, "created_at"),
        updated_at: value_millis(row, "updated_at"),
    })
}

fn read_checkpoints(db: &Connection) -> Vec<CheckpointRow> {
    query_rows(db, "SELECT * FROM checkpoints", |row| CheckpointRow {
        id: value_str(row, "id"),
        session_id: value_str(row, "session_id"),
        title: value_str(row, "title"),
        overview: value_str(row, "overview"),
        work_done: value_str(row, "work_done"),
        technical_details: value_str(row, "technical_details"),
        important_files: value_str(row, "important_files"),
        next_steps: value_str(row, "next_steps"),
        created_at: value_millis(row, "created_at"),
    })
}

fn read_turns(db: &Connection) -> Vec<TurnRow> {
    query_rows(db, "SELECT * FROM turns", |row| TurnRow {
        session_id: value_str(row, "session_id"),
        turn_index: value_str(row, "turn_index"),
        user_message: value_str(row, "user_message"),
        assistant_response: value_str(row, "assistant_response"),
        timestamp: value_millis(row, "timestamp"),
    })
}

fn query_rows<T, F>(db: &Connection, sql: &str, mapper: F) -> Vec<T>
where
    F: Fn(&Row<'_>) -> T,
{
    let mut stmt = match db.prepare(sql) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| Ok(mapper(row))) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(Result::ok).collect()
}

fn build_parent_index(rows: &[SessionRow]) -> HashMap<String, ParentMeta> {
    rows.iter()
        .filter_map(|row| {
            Some((
                row.id.clone()?,
                ParentMeta {
                    repository: row.repository.clone(),
                    branch: row.branch.clone(),
                    cwd: row.cwd.clone(),
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                },
            ))
        })
        .collect()
}

fn memories_from_checkpoint(
    row: &CheckpointRow,
    parents: &HashMap<String, ParentMeta>,
) -> Vec<Memory> {
    let Some(session_id) = row.session_id.as_ref() else {
        return Vec::new();
    };
    let Some(source_ref) = row.id.as_ref() else {
        return Vec::new();
    };
    let parent = parents.get(session_id).cloned().unwrap_or_default();
    let created_at = if row.created_at > 0 {
        row.created_at
    } else {
        parent.created_at
    };
    let base = MemoryBase {
        session_id,
        source_table: "checkpoints",
        source_ref,
        repository: parent.repository.as_deref(),
        branch: parent.branch.as_deref(),
        cwd: parent.cwd.as_deref(),
        created_at,
        updated_at: created_at,
    };

    let mut memories = Vec::new();
    let kind = if row.technical_details.is_some() {
        MemoryKind::Decision
    } else {
        MemoryKind::Learning
    };
    let content = join_content([
        row.overview.as_deref(),
        row.technical_details.as_deref(),
        row.work_done.as_deref(),
    ]);
    if !content.is_empty() {
        memories.push(build_memory(kind, row.title.as_deref(), content, &base));
    }

    if let Some(next_steps) = row.next_steps.as_ref() {
        memories.push(build_memory(
            MemoryKind::Todo,
            row.title.as_deref(),
            next_steps.clone(),
            &base,
        ));
    }

    let files = parse_file_list(row.important_files.as_deref());
    if !files.is_empty() {
        memories.push(build_memory(
            MemoryKind::FileContext,
            row.title.as_deref(),
            files.join("\n"),
            &base,
        ));
    }

    memories
}

fn memory_from_session(row: &SessionRow) -> Option<Memory> {
    let session_id = row.id.as_ref()?;
    let summary = row.summary.as_ref()?;
    let created_at = row.created_at;
    let updated_at = if row.updated_at > 0 {
        row.updated_at
    } else {
        created_at
    };
    Some(Memory {
        id: memory_id(session_id, MemoryKind::Summary, "sessions", session_id),
        session_id: session_id.clone(),
        kind: MemoryKind::Summary,
        title: None,
        content: summary.clone(),
        repository: row.repository.clone(),
        branch: row.branch.clone(),
        cwd: row.cwd.clone(),
        source_table: "sessions".into(),
        source_ref: Some(session_id.clone()),
        created_at,
        updated_at,
    })
}

fn memory_from_turn(row: &TurnRow, parents: &HashMap<String, ParentMeta>) -> Option<Memory> {
    let session_id = row.session_id.as_ref()?;
    let user_message = row.user_message.as_ref()?;
    let source_ref = row.turn_index.clone().unwrap_or_else(|| "0".into());
    let parent = parents.get(session_id).cloned().unwrap_or_default();
    let ts = if row.timestamp > 0 {
        row.timestamp
    } else if parent.updated_at > 0 {
        parent.updated_at
    } else {
        parent.created_at
    };
    let assistant = row.assistant_response.as_ref().map(|value| {
        let truncated = truncate(value, 600);
        format!("-> {truncated}")
    });
    let content = join_content([
        Some(truncate(user_message, 2000).as_str()),
        assistant.as_deref(),
    ]);
    let first_line = user_message
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(user_message);

    Some(Memory {
        id: memory_id(session_id, MemoryKind::Chat, "turns", &source_ref),
        session_id: session_id.clone(),
        kind: MemoryKind::Chat,
        title: Some(truncate(first_line.trim(), 90)),
        content,
        repository: parent.repository,
        branch: parent.branch,
        cwd: parent.cwd,
        source_table: "turns".into(),
        source_ref: Some(source_ref),
        created_at: ts,
        updated_at: ts,
    })
}

struct MemoryBase<'a> {
    session_id: &'a str,
    source_table: &'a str,
    source_ref: &'a str,
    repository: Option<&'a str>,
    branch: Option<&'a str>,
    cwd: Option<&'a str>,
    created_at: u64,
    updated_at: u64,
}

fn build_memory(
    kind: MemoryKind,
    title: Option<&str>,
    content: String,
    base: &MemoryBase<'_>,
) -> Memory {
    Memory {
        id: memory_id(base.session_id, kind, base.source_table, base.source_ref),
        session_id: base.session_id.into(),
        kind,
        title: title.map(ToOwned::to_owned),
        content,
        repository: base.repository.map(ToOwned::to_owned),
        branch: base.branch.map(ToOwned::to_owned),
        cwd: base.cwd.map(ToOwned::to_owned),
        source_table: base.source_table.into(),
        source_ref: Some(base.source_ref.into()),
        created_at: base.created_at,
        updated_at: base.updated_at,
    }
}

fn row_to_memory(row: &Row<'_>) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: value_str(row, "id").unwrap_or_default(),
        session_id: value_str(row, "session_id").unwrap_or_default(),
        kind: value_str(row, "kind")
            .and_then(|value| str_to_kind(&value))
            .unwrap_or(MemoryKind::Summary),
        title: value_str(row, "title"),
        content: value_str(row, "content").unwrap_or_default(),
        repository: value_str(row, "repository"),
        branch: value_str(row, "branch"),
        cwd: value_str(row, "cwd"),
        source_table: value_str(row, "source_table").unwrap_or_default(),
        source_ref: value_str(row, "source_ref"),
        created_at: value_u64(row, "created_at"),
        updated_at: value_u64(row, "updated_at"),
    })
}

fn value_str(row: &Row<'_>, column: &str) -> Option<String> {
    match row.get_ref(column).ok()? {
        ValueRef::Null => None,
        ValueRef::Integer(value) => Some(value.to_string()),
        ValueRef::Real(value) if value.is_finite() => Some(value.to_string()),
        ValueRef::Text(bytes) => {
            let value = std::str::from_utf8(bytes).ok()?.trim();
            (!value.is_empty()).then(|| value.into())
        }
        _ => None,
    }
}

fn value_u64(row: &Row<'_>, column: &str) -> u64 {
    match row.get_ref(column) {
        Ok(ValueRef::Integer(value)) => u64::try_from(value.max(0)).unwrap_or(u64::MAX),
        Ok(ValueRef::Real(value)) if value.is_finite() && value > 0.0 => {
            value.round().min(u64::MAX as f64) as u64
        }
        Ok(ValueRef::Text(bytes)) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

fn value_millis(row: &Row<'_>, column: &str) -> u64 {
    let raw = match row.get_ref(column) {
        Ok(ValueRef::Integer(value)) => return epoch_to_millis(value as f64),
        Ok(ValueRef::Real(value)) => return epoch_to_millis(value),
        Ok(ValueRef::Text(bytes)) => std::str::from_utf8(bytes)
            .ok()
            .map(str::trim)
            .map(str::to_owned),
        _ => None,
    };
    let Some(value) = raw else {
        return 0;
    };
    if value.chars().all(|ch| ch.is_ascii_digit()) {
        return value.parse::<f64>().ok().map(epoch_to_millis).unwrap_or(0);
    }
    time::OffsetDateTime::parse(&value, &time::format_description::well_known::Rfc3339)
        .ok()
        .and_then(|parsed| u64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok())
        .unwrap_or(0)
}

fn epoch_to_millis(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    let millis = if value < 1_000_000_000_000.0 {
        value * 1000.0
    } else {
        value
    };
    millis.round().min(u64::MAX as f64) as u64
}

fn parse_file_list(value: Option<&str>) -> Vec<String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(array) = parsed.as_array() {
            return dedupe_non_empty(array.iter().filter_map(|value| value.as_str()));
        }
        if let Some(object) = parsed.as_object() {
            return dedupe_non_empty(object.keys().map(String::as_str));
        }
    }
    dedupe_non_empty(raw.split([',', '\r', '\n']))
}

fn dedupe_non_empty<'a>(items: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let trimmed = item.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_owned()) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

fn join_content<'a>(parts: impl IntoIterator<Item = Option<&'a str>>) -> String {
    parts
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.into();
    }
    let mut out = value
        .chars()
        .take(max.saturating_sub(1))
        .collect::<String>();
    out.truncate(out.trim_end().len());
    out.push('.');
    out
}

fn memory_id(session_id: &str, kind: MemoryKind, source_table: &str, source_ref: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!(
        "{}|{}|{}|{}",
        session_id,
        kind_to_str(kind),
        source_table,
        source_ref
    ));
    format!("{:x}", hasher.finalize())
        .chars()
        .take(32)
        .collect()
}

fn sanitize_fts_query(query: &str) -> Option<String> {
    let tokens = query
        .split_whitespace()
        .map(str::trim)
        .filter(|token| token.chars().any(char::is_alphanumeric))
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!tokens.is_empty()).then(|| tokens.join(" "))
}

fn session_id_prefix(query: &str) -> Option<String> {
    let query = query.trim().to_ascii_lowercase();
    let hex_count = query.chars().filter(|ch| ch.is_ascii_hexdigit()).count();
    (hex_count >= 8 && query.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')).then_some(query)
}

fn kind_to_str(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Summary => "summary",
        MemoryKind::Decision => "decision",
        MemoryKind::Todo => "todo",
        MemoryKind::Learning => "learning",
        MemoryKind::FileContext => "file_context",
        MemoryKind::Chat => "chat",
    }
}

fn str_to_kind(value: &str) -> Option<MemoryKind> {
    match value {
        "summary" => Some(MemoryKind::Summary),
        "decision" => Some(MemoryKind::Decision),
        "todo" => Some(MemoryKind::Todo),
        "learning" => Some(MemoryKind::Learning),
        "file_context" => Some(MemoryKind::FileContext),
        "chat" => Some(MemoryKind::Chat),
        _ => None,
    }
}

#[allow(dead_code)]
fn _value_from_ref(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Integer(value),
        ValueRef::Real(value) => Value::Real(value),
        ValueRef::Text(value) => Value::Text(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Blob(value.to_vec()),
    }
}
