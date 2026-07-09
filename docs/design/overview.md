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
- **Local & dependency-light.** No cloud, no telemetry, zero native dependencies.

## Layered architecture

`dcs` is one TypeScript codebase with a shared **core** and four delivery layers — CLI, server, web,
and scheduling — on top.

```
              ┌─────────────── Web UI (React + Vite) ───────────────┐
              │   session list · one-click resume · save/restore    │
              └──────────────────────┬──────────────────────────────┘
                                     │ REST (/api, default :4517)
              ┌──────────────────────▼──────────────────────────────┐
   CLI (dcs) ─┤              Local API server (Express)              │
              └──────────────────────┬──────────────────────────────┘
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
| `core/types.ts` | The cross-layer contract: `DiscoveredSession`, `Workspace`, `WindowSpec`, `TabSpec`, `ManagedSession`, `AppConfig`, `ResumeOptions`, `LaunchResult`. Kept free of runtime imports so both Node and browser code can use it. |
| `core/paths.ts` | All filesystem locations — Copilot read paths and the owned state dir — overridable via env vars for hermetic tests. |
| `core/config.ts` | `AppConfig` defaults plus non-throwing load and atomic save. |
| `core/logger.ts` | JSON-lines logger that appends to `state/logs/api-YYYY-MM-DD.log` and mirrors to the console. Logging never throws. |
| `core/discovery` | Scans `~/.copilot/session-state/*/workspace.yaml`, classifies liveness from `inuse.<pid>.lock` + PID checks, flags top-level interactive sessions, and best-effort enriches from `session-store.db`. |
| `core/registry` | Durable file-store of `ManagedSession` and `Workspace` records, one JSON per record, written atomically. |
| `core/launch` | Pure argv builders + runner for `wt.exe` commands that resume sessions; supports color maps, window grouping, dry-run, and cwd fallback. |
| `core/snapshot` | Color assignment + window grouping (`grouping.ts`), capture of the live layout into a `Workspace`, restore, and rolling auto-snapshot retention. |

### Delivery layers

- **`server`** — an Express app exposing the REST API under `/api` (default port `4517`). It also
  serves the built web bundle in production.
- **`web`** — a React + Vite dashboard. In dev it runs on port `4516` and proxies `/api` to the API.
- **`cli`** — the `dcs` command set (`list`, `resume`, `save`, `restore`, `snapshot`,
  `restore-prompt`, `ui`, `serve`, `new`, `install-tasks`, `uninstall-tasks`).
- **`scheduling`** — installs/removes Windows Scheduled Tasks: a periodic `dcs snapshot` and a logon
  `dcs restore-prompt`, with a current-user Startup fallback when ONLOGON registration is denied.

## Data flow

### Discovery

1. Enumerate session folders under `~/.copilot/session-state/`.
2. For each, parse `workspace.yaml` → `name`, `cwd`, `git_root`, `repository`, `branch`.
3. Optionally enrich with a `summary` from `~/.copilot/session-store.db` (best-effort `node:sqlite`).
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

`dcs install-tasks` registers Windows automation:

- a **periodic** task running `dcs snapshot` every `snapshotIntervalMinutes`, and
- a **logon** restore prompt running `dcs restore-prompt`, which — if a recent snapshot exists —
  opens the UI to offer a one-click restore. This is a Scheduled Task when Windows allows it, with a
  current-user Startup-folder fallback when the ONLOGON trigger is denied.

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
- **Stack rationale.** Why TypeScript + Express + Vite/React, and why zero native deps, is covered in
  [ADR 0001](decisions/0001-stack-and-architecture.md).
