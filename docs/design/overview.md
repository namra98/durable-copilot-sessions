# Architecture Overview

This document describes how **durable-copilot-sessions** (`dcs`) is put together: its layers, how data
flows through a save/restore cycle, and the on-disk state it owns. For the rationale behind these
choices, see the [Architecture Decision Records](decisions/).

## Goals

- **Durable.** The layout (which sessions, in which tabs, with which titles/colors, grouped into which
  windows) must survive reboots, forced Windows updates, and crashes.
- **Honest fidelity.** Restore as exactly as Windows Terminal allows, and degrade gracefully (and
  visibly) where it doesn't.
- **Non-invasive.** Read Copilot's state; never write it.
- **Local & dependency-light.** No cloud, no telemetry, with a Rust backend for fast local discovery
  and API responses.

## Layered architecture

`dcs` now uses a Rust backend/core with a Rust CLI and Axum API. The React dashboard remains a
legacy/dev client of the same `/api` contract, while future TUI work can consume the frozen JSON
contract directly.

```
              ┌─────────────── Web UI (React + Vite) ───────────────┐
              │   legacy/dev client of the frozen /api contract      │
              └──────────────────────┬──────────────────────────────┘
                                     │ REST (/api, default :4517)
              ┌──────────────────────▼──────────────────────────────┐
   CLI (dcs) ─┤              Local API server (Rust/Axum)            │
              └──────────────────────┬──────────────────────────────┘
                                     │
                              Rust core (dcs-core)
                                     │
     ┌───────────────┬───────────────┼────────────────┬─────────────┐
  discovery       registry        launch            snapshot     scheduling
 (read Copilot   (owned JSON     (wt.exe +         (capture &     (Windows
  session state)  state store)    copilot resume)   restore)      Scheduled Tasks)
     │               │               │                 │              │
     ▼               ▼               ▼                 ▼              ▼
 ~/.copilot/    ~/.durable-      wt.exe new-tab     Workspace     periodic snapshot
 session-state  copilot-         -d <cwd> ...       JSON +        + logon restore
 (read-only)    sessions/state   copilot --resume   grouping      prompt
```

### Core modules

| Module | Responsibility |
| --- | --- |
| `rust/dcs-core/src/model.rs` | The serde API/state contract: discovered sessions, managed sessions, workspaces, launch results, config, memory, stats, logs, fork/new-session payloads. |
| `rust/dcs-core/src/paths.rs` | All filesystem locations — Copilot read paths and the owned state dir — overridable via env vars for hermetic tests. |
| `rust/dcs-core/src/registry.rs` | `AppConfig` defaults plus atomic JSON stores for managed sessions, workspaces, snapshots, exports, and imports. |
| `rust/dcs-core/src/discovery.rs` | Scans `~/.copilot/session-state/*/workspace.yaml`, classifies liveness from `inuse.<pid>.lock` + PID checks, flags top-level interactive sessions, and live-first sorts. |
| `rust/dcs-core/src/launch.rs` | Pure argv/script builders + runner for `wt.exe` commands that resume sessions; supports color maps, window grouping, dry-run, cwd fallback, and executable preflight. |
| `rust/dcs-core/src/manager.rs` | Facade that composes discovery, registry, launch, graph, memory, stats, logs/transcripts, fork/new-session, and workspace operations for HTTP/CLI callers. |
| `rust/dcs-core/src/memory.rs` | Local SQLite/FTS5 memory extraction, indexing, search, related-session lookup, and recall context. |
| `rust/dcs-core/src/scheduling.rs` | Windows Scheduled Tasks argument builders, executor seam, and hidden VBScript launcher generation. |

### Delivery layers

- **`rust/dcs`** — the Rust `dcs-rs` command set and Axum API under `/api` (default port `4517`).
  The npm-linked `dcs` command is a thin Node launcher that delegates to `dcs-rs`.
- **`src/web`** — a React + Vite dashboard retained as a legacy/dev API client. In dev it runs on
  port `4516` and proxies `/api` to the Rust API.
- **legacy TypeScript backend** — retained for contract drift tests and safe cutover, not the
  primary runtime.

## Data flow

### Discovery

1. Enumerate session folders under `~/.copilot/session-state/`.
2. For each, parse `workspace.yaml` → `name`, `cwd`, `git_root`, `repository`, `branch`.
3. Optionally enrich with stats/memory from `~/.copilot/session-store.db` through read-only SQLite
   queries.
4. Classify **liveness** from `inuse.<pid>.lock` files and PID liveness:
   - `live` — a lock exists and its PID is running;
   - `stale` — a lock exists but its PID is dead;
   - `inactive` — no lock present.
5. Record which PIDs are alive (`livePids`) and best-effort flag **top-level interactive** sessions
   (a single PID can lock several sessions when subagents are involved).

The result is a list of `DiscoveredSession` objects — the read-only view of the world.

### Save / snapshot

1. Discover sessions (default: top-level, live).
2. Look up any `ManagedSession` overrides (title, color, group, pinned/hidden).
3. Group sessions into windows using `windowGrouping` (`by-repo` | `by-cwd` | `single`) and assign
   each tab a color: a managed override if present, otherwise an auto color from `colorStrategy`
   (`by-repo` | `by-cwd` | `rotate` | `fixed`). Auto colors are a **stable hash → palette** mapping,
   so the same key always gets the same color.
4. Materialize a `Workspace` (`windows[] → tabs[]`, each tab `{ sessionId, title, color, cwd }`) and
   persist it as JSON under the registry (manual `save`) or snapshots dir (auto-snapshot).

`dcs save` produces a named `manual` workspace; `dcs snapshot` produces an `auto-snapshot` workspace
and prunes old snapshots to `maxAutoSnapshots`.

### Restore

1. Load the target `Workspace` from disk.
2. For each window, build a `wt.exe` invocation; for each tab, build a command that `cd`s to the
   tab's `cwd` and runs `copilot --resume`.
3. **cwd fallback:** if a tab's `cwd` no longer exists, fall back to the session's `gitRoot`, then the
   home directory, accumulating a warning into the `LaunchResult`.
4. Execute (or, in dry-run, just return the argv for tests), targeting a new or current window per
   `WindowTarget`.

### Scheduled durability

`dcs install-tasks` registers two Windows Scheduled Tasks:

- a **periodic** task running `dcs snapshot` every `snapshotIntervalMinutes`, and
- a **logon** task running `dcs restore-prompt`, which — if a recent snapshot exists — opens the UI to
  offer a one-click restore.

This is what closes the loop after a forced restart.

## On-disk state layout

Everything the tool owns lives under `~/.durable-copilot-sessions/state/` (override with
`DCS_STATE_DIR`):

```
~/.durable-copilot-sessions/state/
├── config.json                  # AppConfig
├── registry/
│   ├── sessions/                # one ManagedSession JSON per customized session
│   │   └── <copilotSessionId>.json
│   └── workspaces/              # one Workspace JSON per saved (manual) layout
│       └── <workspaceId>.json
├── snapshots/                   # rolling auto-snapshots (pruned to maxAutoSnapshots)
│   └── <timestamp>.json
├── launch-scripts/              # generated scripts wt.exe runs per tab
└── logs/
    └── api-YYYY-MM-DD.log       # JSON-lines log records
```

Copilot's own state, read but never written, lives under `~/.copilot/` (override with
`DCS_COPILOT_HOME`):

```
~/.copilot/
├── session-state/
│   └── <copilotSessionId>/
│       ├── workspace.yaml       # name, cwd, git_root, repository, branch
│       └── inuse.<pid>.lock     # liveness signal (PID holding the session)
└── session-store.db             # SQLite index (optional summary enrichment)
```

## Design notes & limitations

- **Windows Terminal has no live-tab introspection.** There is no API to read a live tab's color,
  title, or window grouping, so exact restore relies on metadata the tool records when you launch or
  customize sessions through it. See
  [ADR 0003](decisions/0003-wt-restore-and-color-fidelity.md).
- **Resume is cwd-scoped.** Copilot's resume picker is per working directory, so every restored tab
  must `cd` first. See [ADR 0002](decisions/0002-discovery-and-resume-model.md).
- **Stack rationale.** The original TypeScript stack is covered in
  [ADR 0001](decisions/0001-stack-and-architecture.md); the Rust backend migration is covered in
  [ADR 0004](decisions/0004-rust-backend-migration.md).
