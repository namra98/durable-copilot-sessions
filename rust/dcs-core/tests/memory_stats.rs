use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use dcs_core::memory::{extract_memories, SqliteMemoryStore};
use dcs_core::model::MemoryKind;
use dcs_core::stats::compute_stats_with_generated_at;
use rusqlite::{params, Connection};

fn temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "dcs-rust-memory-stats-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn create_source_db() -> (PathBuf, PathBuf) {
    let dir = temp_dir();
    let db_path = dir.join("session-store.db");
    let db = Connection::open(&db_path).unwrap();
    db.execute_batch(
        r#"
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT,
          repository TEXT,
          branch TEXT,
          summary TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE checkpoints (
          id TEXT,
          session_id TEXT,
          title TEXT,
          overview TEXT,
          work_done TEXT,
          technical_details TEXT,
          important_files TEXT,
          next_steps TEXT,
          created_at TEXT
        );
        CREATE TABLE turns (
          session_id TEXT,
          turn_index INTEGER,
          user_message TEXT,
          assistant_response TEXT,
          timestamp INTEGER
        );
        "#,
    )
    .unwrap();
    (dir, db_path)
}

#[test]
fn computes_stats_defensively_from_session_store() {
    let (dir, db_path) = create_source_db();
    let db = Connection::open(&db_path).unwrap();
    db.execute(
        "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "s1",
            r"C:\one",
            "octo/alpha",
            "main",
            "summary",
            "2026-07-01T00:00:00Z",
            "2026-07-08T12:00:00Z"
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "s2",
            r"C:\two",
            "octo/alpha",
            "main",
            "summary",
            1_783_536_000_i64,
            1_783_536_000_i64
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "s3",
            r"C:\three",
            "octo/beta",
            "dev",
            "summary",
            "2026-07-01T00:00:00Z",
            "2026-07-08T12:00:00Z"
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "s4",
            r"C:\empty",
            "",
            "dev",
            "summary",
            "2026-07-01T00:00:00Z",
            "2026-07-09T12:00:00Z"
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO checkpoints (id, session_id) VALUES ('c1', 's1')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO turns (session_id, turn_index, user_message) VALUES ('s1', 0, 'hello')",
        [],
    )
    .unwrap();

    let stats = compute_stats_with_generated_at(&db_path, "2026-07-09T10:00:00.000Z");
    assert_eq!(stats.total_sessions, 4);
    assert_eq!(stats.total_checkpoints, 1);
    assert_eq!(stats.total_turns, 1);
    assert_eq!(stats.top_repos[0].repository, "octo/alpha");
    assert_eq!(stats.top_repos[0].sessions, 2);
    assert_eq!(stats.top_repos[1].repository, "octo/beta");
    assert_eq!(stats.activity_by_day.len(), 30);
    assert_eq!(stats.activity_by_day.first().unwrap().date, "2026-06-10");
    assert_eq!(stats.activity_by_day.last().unwrap().date, "2026-07-09");
    assert_eq!(
        stats
            .activity_by_day
            .iter()
            .find(|day| day.date == "2026-07-08")
            .unwrap()
            .sessions,
        3
    );

    drop(db);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn missing_stats_database_returns_zeroed_report_with_activity_window() {
    let dir = temp_dir();
    let missing = dir.join("missing.db");
    let stats = compute_stats_with_generated_at(&missing, "2026-07-09T10:00:00.000Z");
    assert_eq!(stats.total_sessions, 0);
    assert_eq!(stats.top_repos, vec![]);
    assert_eq!(stats.activity_by_day.len(), 30);
    assert_eq!(stats.activity_by_day[0].date, "2026-06-10");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn extracts_and_indexes_memories_idempotently() {
    let (dir, source_db) = create_source_db();
    let db = Connection::open(&source_db).unwrap();
    db.execute(
        "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            r"C:\repo",
            "octo/alpha",
            "main",
            "Session summary",
            "2026-07-01T00:00:00Z",
            "2026-07-02T00:00:00Z"
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            r"C:\repo",
            "octo/alpha",
            "main",
            "Other summary",
            "2026-07-01T00:00:00Z",
            "2026-07-03T00:00:00Z"
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO checkpoints
         (id, session_id, title, overview, work_done, technical_details, important_files, next_steps, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            "cp1",
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "Architecture",
            "Overview text",
            "Work done text",
            "Chose Rust service",
            "[\"src/core/manager.ts\", \"src/core/types.ts\"]",
            "Port HTTP API",
            "2026-07-02T01:00:00Z"
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            1,
            "Discuss snappy Rust migration",
            "Use fixtures first",
            1_783_536_000_i64
        ],
    )
    .unwrap();

    let extracted = extract_memories(&source_db);
    assert_eq!(extracted.len(), 6);
    assert!(extracted
        .iter()
        .any(|memory| memory.kind == MemoryKind::Decision));
    assert!(extracted
        .iter()
        .any(|memory| memory.kind == MemoryKind::Todo));
    assert!(extracted
        .iter()
        .any(|memory| memory.kind == MemoryKind::FileContext));
    assert!(extracted
        .iter()
        .any(|memory| memory.kind == MemoryKind::Chat));

    let memory_db = dir.join("memory.db");
    let mut store = SqliteMemoryStore::open(&memory_db).unwrap();
    assert_eq!(store.reindex(&source_db).unwrap(), 6);
    assert_eq!(store.reindex(&source_db).unwrap(), 6);
    assert_eq!(store.count(), 6);

    let hits = store.search("snappy migration", Some("octo/alpha"), None, Some(10));
    assert!(!hits.is_empty());
    assert!(hits.iter().any(|hit| hit.memory.kind == MemoryKind::Chat));

    let session_memories = store.list_for_session("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert_eq!(session_memories.len(), 5);

    let related = store.related("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Some(10));
    assert_eq!(related.len(), 1);
    assert_eq!(
        related[0].session_id,
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    );

    let recall = store.recall(Some("octo/alpha"), Some("main"), Some(10));
    assert_eq!(recall.decisions.len(), 1);
    assert_eq!(recall.todos.len(), 1);
    assert_eq!(recall.summaries.len(), 2);
    assert_eq!(
        recall.files,
        vec![
            "src/core/manager.ts".to_owned(),
            "src/core/types.ts".to_owned()
        ]
    );

    let id = session_memories
        .iter()
        .find(|memory| memory.kind == MemoryKind::Decision)
        .unwrap()
        .id
        .clone();
    let extracted_again = extract_memories(&source_db);
    assert_eq!(
        extracted_again
            .iter()
            .find(|memory| memory.kind == MemoryKind::Decision)
            .unwrap()
            .id,
        id
    );

    drop(store);
    drop(db);
    fs::remove_dir_all(dir).unwrap();
}
