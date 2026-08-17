use std::collections::BTreeMap;
use std::fmt::Debug;

use dcs_core::model::{
    CreateWorkspaceBody, DiscoveredSession, LaunchResult, LogRecord, Memory, MemoryKind,
    MemoryRecallPack, MemorySearchHit, ResumeBatchBody, ResumeOptions, SessionFilter,
    SessionLiveness, SessionPatch, StatsActivity, StatsRepo, StatsReport, WindowTarget,
    WorkspaceDiff, WorkspaceDiffEntry,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

fn assert_json_round_trip<T>(value: T, expected: Value)
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let encoded = serde_json::to_value(&value).unwrap();
    assert_eq!(encoded, expected);
    let decoded: T = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded, value);
}

fn memory(kind: MemoryKind) -> Memory {
    Memory {
        id: "memory-1".into(),
        session_id: "11111111-1111-1111-1111-111111111111".into(),
        kind,
        title: Some("Decision".into()),
        content: "Keep Copilot state read-only.".into(),
        repository: Some("namra98/durable-copilot-sessions".into()),
        branch: Some("main".into()),
        cwd: Some(r"C:\Users\example\repos\durable-copilot-sessions".into()),
        source_table: "checkpoints".into(),
        source_ref: Some("checkpoint-1".into()),
        created_at: 1_788_759_600_000,
        updated_at: 1_788_759_660_000,
    }
}

#[test]
fn discovered_session_uses_current_json_field_names() {
    assert_json_round_trip(
        DiscoveredSession {
            id: "11111111-1111-1111-1111-111111111111".into(),
            cwd: r"C:\Users\example\repos\durable-copilot-sessions".into(),
            cwd_exists: true,
            name: Some("Backend session".into()),
            summary: Some("Migrating the backend".into()),
            git_root: Some(r"C:\Users\example\repos\durable-copilot-sessions".into()),
            repository: Some("namra98/durable-copilot-sessions".into()),
            branch: Some("main".into()),
            client_name: Some("github/cli".into()),
            created_at: Some("2026-07-09T00:00:00.000Z".into()),
            updated_at: Some("2026-07-09T00:05:00.000Z".into()),
            liveness: SessionLiveness::Live,
            live_pids: vec![4242],
            top_level: true,
            branch_of: Some("00000000-0000-0000-0000-000000000000".into()),
            branch_note: Some("Investigate Rust migration".into()),
        },
        json!({
            "id": "11111111-1111-1111-1111-111111111111",
            "cwd": r"C:\Users\example\repos\durable-copilot-sessions",
            "cwdExists": true,
            "name": "Backend session",
            "summary": "Migrating the backend",
            "gitRoot": r"C:\Users\example\repos\durable-copilot-sessions",
            "repository": "namra98/durable-copilot-sessions",
            "branch": "main",
            "clientName": "github/cli",
            "createdAt": "2026-07-09T00:00:00.000Z",
            "updatedAt": "2026-07-09T00:05:00.000Z",
            "liveness": "live",
            "livePids": [4242],
            "topLevel": true,
            "branchOf": "00000000-0000-0000-0000-000000000000",
            "branchNote": "Investigate Rust migration"
        }),
    );
}

#[test]
fn launch_and_resume_payloads_preserve_camel_case_contract() {
    assert_json_round_trip(
        LaunchResult {
            ok: false,
            tabs_launched: 2,
            windows_opened: 1,
            warnings: vec!["cwd missing; fell back to git root".into()],
            error: Some("wt.exe failed".into()),
        },
        json!({
            "ok": false,
            "tabsLaunched": 2,
            "windowsOpened": 1,
            "warnings": ["cwd missing; fell back to git root"],
            "error": "wt.exe failed"
        }),
    );

    assert_json_round_trip(
        ResumeOptions {
            session_id: "11111111-1111-1111-1111-111111111111".into(),
            title: Some("Backend".into()),
            color: Some("#3B82F6".into()),
            cwd: Some(r"C:\repo".into()),
            fallbacks: Some(vec![r"C:\fallback".into()]),
            window: Some(WindowTarget::Current),
            copilot_args: Some(vec!["--allow-all-tools".into()]),
            copilot_command: Some("copilot".into()),
            dry_run: Some(true),
        },
        json!({
            "sessionId": "11111111-1111-1111-1111-111111111111",
            "title": "Backend",
            "color": "#3B82F6",
            "cwd": r"C:\repo",
            "fallbacks": [r"C:\fallback"],
            "window": "current",
            "copilotArgs": ["--allow-all-tools"],
            "copilotCommand": "copilot",
            "dryRun": true
        }),
    );
}

#[test]
fn mutable_api_bodies_can_serialize_intentional_empty_arrays() {
    assert_json_round_trip(
        SessionPatch {
            title: None,
            color: None,
            group: None,
            pinned: None,
            hidden: None,
            tags: Some(vec![]),
            archived: Some(false),
        },
        json!({
            "tags": [],
            "archived": false
        }),
    );

    assert_json_round_trip(
        CreateWorkspaceBody {
            name: "morning-layout".into(),
            description: None,
            from_live: Some(true),
            filter: Some(SessionFilter::Open),
            windows: Some(vec![]),
        },
        json!({
            "name": "morning-layout",
            "fromLive": true,
            "filter": "open",
            "windows": []
        }),
    );

    assert_json_round_trip(
        ResumeBatchBody {
            session_ids: vec!["11111111-1111-1111-1111-111111111111".into()],
            window: Some(WindowTarget::New),
        },
        json!({
            "sessionIds": ["11111111-1111-1111-1111-111111111111"],
            "window": "new"
        }),
    );
}

#[test]
fn memory_models_preserve_recall_contract_field_names() {
    let decision = memory(MemoryKind::Decision);
    assert_json_round_trip(
        decision.clone(),
        json!({
            "id": "memory-1",
            "sessionId": "11111111-1111-1111-1111-111111111111",
            "kind": "decision",
            "title": "Decision",
            "content": "Keep Copilot state read-only.",
            "repository": "namra98/durable-copilot-sessions",
            "branch": "main",
            "cwd": r"C:\Users\example\repos\durable-copilot-sessions",
            "sourceTable": "checkpoints",
            "sourceRef": "checkpoint-1",
            "createdAt": 1788759600000u64,
            "updatedAt": 1788759660000u64
        }),
    );

    let file_context = memory(MemoryKind::FileContext);
    assert_eq!(
        serde_json::to_value(&file_context).unwrap()["kind"],
        "file_context"
    );

    assert_json_round_trip(
        MemorySearchHit {
            memory: file_context.clone(),
            score: 0.75,
            snippet: Some("Copilot state read-only".into()),
        },
        json!({
            "memory": serde_json::to_value(&file_context).unwrap(),
            "score": 0.75,
            "snippet": "Copilot state read-only"
        }),
    );

    assert_json_round_trip(
        MemoryRecallPack {
            repository: Some("namra98/durable-copilot-sessions".into()),
            branch: Some("main".into()),
            decisions: vec![decision],
            todos: vec![],
            summaries: vec![],
            files: vec!["src/core/types.ts".into()],
        },
        json!({
            "repository": "namra98/durable-copilot-sessions",
            "branch": "main",
            "decisions": [serde_json::to_value(memory(MemoryKind::Decision)).unwrap()],
            "todos": [],
            "summaries": [],
            "files": ["src/core/types.ts"]
        }),
    );
}

#[test]
fn stats_diff_and_logs_preserve_api_shapes() {
    assert_json_round_trip(
        WorkspaceDiff {
            missing: vec![WorkspaceDiffEntry {
                session_id: "missing-session".into(),
                title: "Missing".into(),
                detail: "session no longer discovered".into(),
            }],
            stale_cwd: vec![],
            changed: vec![],
            added_live: vec![],
            unchanged: 1,
        },
        json!({
            "missing": [{
                "sessionId": "missing-session",
                "title": "Missing",
                "detail": "session no longer discovered"
            }],
            "staleCwd": [],
            "changed": [],
            "addedLive": [],
            "unchanged": 1
        }),
    );

    assert_json_round_trip(
        StatsReport {
            total_sessions: 10,
            total_checkpoints: 4,
            total_turns: 42,
            top_repos: vec![StatsRepo {
                repository: "namra98/durable-copilot-sessions".into(),
                sessions: 3,
            }],
            activity_by_day: vec![StatsActivity {
                date: "2026-07-09".into(),
                sessions: 2,
            }],
            generated_at: "2026-07-09T00:00:00.000Z".into(),
        },
        json!({
            "totalSessions": 10,
            "totalCheckpoints": 4,
            "totalTurns": 42,
            "topRepos": [{ "repository": "namra98/durable-copilot-sessions", "sessions": 3 }],
            "activityByDay": [{ "date": "2026-07-09", "sessions": 2 }],
            "generatedAt": "2026-07-09T00:00:00.000Z"
        }),
    );

    let mut extra = BTreeMap::new();
    extra.insert(
        "sessionId".into(),
        json!("11111111-1111-1111-1111-111111111111"),
    );
    assert_json_round_trip(
        LogRecord {
            ts: Some("2026-07-09T00:00:00.000Z".into()),
            level: Some("info".into()),
            message: Some("started".into()),
            scope: Some("api".into()),
            extra,
        },
        json!({
            "ts": "2026-07-09T00:00:00.000Z",
            "level": "info",
            "message": "started",
            "scope": "api",
            "sessionId": "11111111-1111-1111-1111-111111111111"
        }),
    );
}
