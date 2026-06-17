# Durable Copilot Sessions

> Save, snapshot, and one‑click **restore** your GitHub Copilot CLI sessions across Windows Terminal
> windows and tabs — durable across reboots.

![Platform](https://img.shields.io/badge/platform-Windows%2011-0078D6)
![Node](https://img.shields.io/badge/node-%3E%3D20-3C873A)
![Stack](https://img.shields.io/badge/stack-TypeScript%20%C2%B7%20Express%20%C2%B7%20React-3178C6)
![Status](https://img.shields.io/badge/status-alpha-orange)

---

## The problem

You run **dozens** of Copilot CLI sessions at once, each in its own Windows Terminal tab — named and
color‑coded so you can tell parallel streams of work apart at a glance. Then Windows decides it's time
for a forced restart to install updates.

When the machine comes back, **the entire live layout is gone**:

- every tab **title** you set,
- every tab **color** you assigned,
- the way tabs were **grouped into windows**, and
- the mapping of **which tab held which Copilot session**.

The good news: Copilot's *session state* survives on disk under `~/.copilot/session-state`. The bad
news: Windows Terminal's layout is volatile, and there is no built‑in way to put it all back. You're
left manually hunting for sessions and rebuilding your workspace tab by tab.

## The solution

**Durable Copilot Sessions** (`dcs`) is a local, Windows‑only tool that:

1. **Discovers** your Copilot CLI sessions by reading Copilot's own on‑disk state (read‑only).
2. **Records** durable metadata (titles, colors, window grouping) for sessions you launch or
   customize through the tool.
3. **Snapshots** your live layout on a schedule, and
4. **Restores** the exact Windows Terminal windows + tabs with one click — each Copilot session
   reattached via `copilot --resume` in its original working directory.

Because all of this state lives on disk under `~/.durable-copilot-sessions/state/`, it **survives
reboots, forced updates, and crashes**.

> The tool only ever **reads** `~/.copilot`. It never modifies Copilot's own session state.

---

## Features

- 🔎 **Auto‑discovery** of Copilot sessions — even ones you never launched through the tool — with
  live / stale / inactive status derived from `inuse.<pid>.lock` files and PID liveness checks.
- 🖱️ **One‑click resume** from the web dashboard or `dcs resume <id>`: opens a Windows Terminal tab,
  `cd`s to the session's recorded working directory, and runs `copilot --resume`.
- 💾 **Named workspaces** — `dcs save <name>` captures the current live layout; `dcs restore <name>`
  reopens every window and tab exactly as saved.
- ⏱️ **Rolling auto‑snapshots** via a Windows Scheduled Task, plus a **logon restore prompt** so a
  forced restart never costs you your layout.
- 🎨 **Color & title fidelity** for sessions managed through the tool; sensible auto‑assigned colors
  and repository‑based window grouping for everything else.
- 🌐 **Local web dashboard** (React + Vite) backed by a small Express API — no cloud, no telemetry.
- 🧰 **`dcs` CLI** for everything the UI does, scriptable and CI‑friendly.
- 📦 **Zero native dependencies.** Pure TypeScript; optional SQLite enrichment uses Node's built‑in
  `node:sqlite` behind a best‑effort guard.

---

## Screenshots

> _Placeholder — add dashboard screenshots to `assets/` and reference them here._

| Dashboard | Restore prompt |
| --- | --- |
| `![Dashboard](assets/dashboard.png)` | `![Restore prompt](assets/restore-prompt.png)` |

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Windows 11** | The tool drives `wt.exe`; it is Windows‑only by design. |
| **Windows Terminal** | `wt.exe` must be on `PATH` (the default on Windows 11). |
| **Node.js ≥ 20** | ESM + `node:sqlite`. Node 22/24 are fine. |
| **GitHub Copilot CLI** | `copilot` must be on `PATH` so restored tabs can run `copilot --resume`. |

---

## Install

**One-liner** (clone + install + build + link `dcs` onto your PATH), from a
PowerShell prompt:

```powershell
git clone https://github.com/namra98/durable-copilot-sessions.git; cd durable-copilot-sessions; ./scripts/install.ps1 -WithTasks
```

`install.ps1 -WithTasks` also registers the auto-snapshot + logon-restore
Scheduled Tasks. Omit `-WithTasks` to set those up later with `dcs install-tasks`.

<details>
<summary>Manual / step-by-step</summary>

```bash
git clone https://github.com/namra98/durable-copilot-sessions.git
cd durable-copilot-sessions
npm run setup     # npm install + npm run build + npm link  →  `dcs` on PATH
```

`npm run setup` compiles the Node code (`tsc`), bundles the web dashboard
(`vite build`) into `dist/`, and `npm link`s the `dcs` bin (`dist/cli/index.js`)
onto your PATH. Verify your environment afterward with `dcs doctor`.
</details>

---

## Quick start

**1. See what's out there.** List your discovered Copilot sessions (live ones first):

```bash
dcs list            # live + recently active sessions
dcs list --all      # include stale/inactive sessions too
```

**2. Open the dashboard.** Start the local API and open the web UI in your browser:

```bash
dcs ui
```

During development you can run the API and Vite dev server together with hot reload:

```bash
npm run dev         # api on :4517, dashboard on :4516
```

**3. Resume a session** in a fresh Windows Terminal tab:

```bash
dcs resume 8f3c1a2b --title "api-refactor" --color "#3B82F6"
```

**4. Save and restore your layout:**

```bash
dcs save morning-layout --all --description "All my active work streams"
# ...later, or after a reboot...
dcs restore morning-layout
```

**5. Make it automatic.** Register the periodic snapshot + logon‑restore Scheduled Tasks:

```bash
dcs install-tasks --interval 5
```

Now your layout is captured every few minutes, and after the next forced restart you'll be prompted
to restore it.

---

## CLI reference

All commands are subcommands of `dcs`.

| Command | Description |
| --- | --- |
| `dcs list [--all]` | List discovered sessions (live first) with name, cwd, repo, branch, and liveness. `--all` includes stale/inactive sessions. |
| `dcs resume <sessionId> [--window new\|current] [--color <c>] [--title <t>]` | Open a Windows Terminal tab that resumes the given session in its recorded cwd. |
| `dcs save <name> [--all] [--description <d>]` | Save the current live layout as a named workspace. `--all` includes non‑top‑level sessions. |
| `dcs restore <name\|id> [--window new\|current]` | Relaunch a saved workspace's windows + tabs. |
| `dcs snapshot` | Take a rolling auto‑snapshot of the current layout (used by the Scheduled Task). |
| `dcs restore-prompt` | On logon, if a recent snapshot exists, prompt and open the UI to restore it. |
| `dcs ui` | Start the local API server and open the web dashboard in the browser. |
| `dcs serve [--port <n>]` | Start the API server **without** opening a browser. |
| `dcs new <title> [--cwd <dir>] [--color <c>] [--prompt <p>]` | Launch a brand‑new managed Copilot session in a Windows Terminal tab. |
| `dcs install-tasks [--interval <minutes>] [--no-hidden]` | Register the periodic snapshot + logon restore Scheduled Tasks. Runs hidden (no console flash) by default; `--no-hidden` shows a window. |
| `dcs uninstall-tasks` | Remove the Scheduled Tasks. |
| `dcs tasks-status` | Report whether the snapshot + logon-restore tasks are installed. |
| `dcs restore-last [--window new\|current]` | Restore the most recent auto-snapshot. |
| `dcs resume-repo <repository> [--window ...]` | Resume every open session matching a repository as one grouped window. |
| `dcs fork <sessionId>` | Fork a session (records lineage for the Graph view). |
| `dcs recall <query...>` | Search local memory / chat history for sessions by free text. |
| `dcs reindex-memory` | Rebuild the local memory/recall index. |
| `dcs stats` / `dcs transcript <id>` / `dcs diff <workspace>` | Show usage stats, a session transcript, or a workspace-vs-live diff. |
| `dcs export-workspaces [file]` / `dcs import-workspaces <file>` | Export/import saved workspaces as JSON. |
| `dcs clean` | Prune stale registry entries. |
| `dcs tray` | Launch the always-on system tray (Windows PowerShell, STA). |
| `dcs doctor [--json]` | Run environment health checks (wt, PowerShell, copilot, Node, state dirs, tasks). |

`--window` controls whether a relaunch targets a **new** Windows Terminal window (default) or the
**current** one.

---

## Web dashboard

`dcs ui` (or `npm run dev`) serves a React dashboard that mirrors the CLI:

- a list of **live** and **known** sessions with name, cwd, repository, branch, and liveness;
- **one‑click resume** for any session;
- **save** the current layout as a workspace and **restore** any saved workspace;
- per‑session **color / title editing** that is persisted as managed metadata so it survives the next
  reboot.

In production the dashboard is served by the Express API. In development, Vite serves it on
`:4516` and proxies `/api` to the Express server on `:4517`.

---

## Architecture

`dcs` is a single TypeScript codebase organized into a shared core with four delivery layers (CLI,
server, web, scheduling) on top.

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

| Layer | Responsibility |
| --- | --- |
| `core/discovery` | Scan `~/.copilot/session-state/*/workspace.yaml`, classify liveness from `inuse.<pid>.lock` + PID checks, flag top‑level interactive sessions, and (best‑effort) enrich from `session-store.db`. |
| `core/registry` | Durable file‑store: one JSON per managed session and one per workspace, written atomically under the owned state dir. |
| `core/launch` | Build and run `wt.exe` commands that open tabs running `copilot --resume`, applying color maps, window grouping, and cwd fallback. Argv builders are pure and unit‑tested via dry‑run. |
| `core/snapshot` | Capture the current live layout into a `Workspace`, group tabs into windows, restore them, and manage rolling auto‑snapshots with retention. |
| `server` | Express API that exposes sessions, workspaces, resume, snapshot, restore, and config. |
| `web` | React dashboard that talks to the API. |
| `cli` | The `dcs` command set. |
| `scheduling` | Install/remove Windows Scheduled Tasks for periodic snapshots and the logon restore prompt. |

See [`docs/design/overview.md`](docs/design/overview.md) for a deeper walkthrough and the on‑disk
state layout, and the [Architecture Decision Records](docs/design/decisions/) for the reasoning
behind the stack, the discovery/resume model, and the Windows Terminal fidelity trade‑offs.

---

## How it works

### 1. Discovery

Copilot writes one folder per session under `~/.copilot/session-state/<id>/`. Each contains a
`workspace.yaml` with the session's `name`, `cwd`, `git_root`, `repository`, and `branch`. Discovery
reads these, optionally enriches them with a summary from `~/.copilot/session-store.db`, and
classifies each session's **liveness**:

| Liveness | Meaning |
| --- | --- |
| `live` | A current `inuse.<pid>.lock` exists and the PID is a running process. |
| `stale` | A lock file exists but its PID is dead (the session crashed or was killed). |
| `inactive` | No lock file; the session exists on disk but isn't open. |

Because a single PID can hold locks for several sessions (subagents), discovery also makes a
best‑effort attempt to flag **top‑level interactive** sessions — these are what `dcs save` captures by
default.

### 2. Registry

Anything the tool *owns* — your chosen titles, colors, grouping, pinned/hidden flags, and saved
workspaces — is stored as plain JSON under `~/.durable-copilot-sessions/state/`. Writes are atomic
(write‑to‑temp + rename), so an interrupted snapshot can never corrupt your registry.

### 3. Snapshot

A snapshot turns the current live layout into a durable `Workspace`: a set of windows, each holding
ordered tabs, each tab resuming one Copilot session with a title, color, and cwd. Auto‑snapshots roll
on a schedule and are pruned to `maxAutoSnapshots`.

### 4. Restore

To restore, the tool builds `wt.exe` commands from the saved `Workspace`. Each tab `cd`s to its
recorded cwd and runs `copilot --resume`. Restore is resilient to a moved working directory:

> **cwd fallback:** if a tab's recorded `cwd` no longer exists, restore falls back to the session's
> git root, then to your home directory, emitting a warning rather than failing.

---

## REST API

The Express server exposes a small JSON API under the `/api` base path (default port **4517**).

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness probe for the server. |
| `GET /api/sessions?filter=live\|all` | List discovered sessions (default `live`). |
| `PATCH /api/sessions/:id` | Update managed metadata (title, color, group, pinned, hidden) for a session. |
| `POST /api/sessions/:id/resume` | Resume a session in a new Windows Terminal tab. |
| `GET /api/workspaces` | List saved workspaces. |
| `POST /api/workspaces` | Save the current layout as a workspace. |
| `DELETE /api/workspaces/:id` | Delete a saved workspace. |
| `POST /api/workspaces/:id/restore` | Restore a saved workspace's windows + tabs. |
| `POST /api/snapshot` | Take a rolling auto‑snapshot now. |
| `GET /api/config` | Return the effective `AppConfig`. |

---

## Configuration

Configuration is loaded from `~/.durable-copilot-sessions/state/config.json`. Any fields you omit
fall back to built‑in defaults; a missing or corrupt file is ignored and defaults are used. The
effective config is also available from `GET /api/config`.

### `AppConfig` fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiPort` | `number` | `4517` | Port for the local Express API server. |
| `webPort` | `number` | `4516` | Port for the Vite web dev server. |
| `snapshotIntervalMinutes` | `number` | `5` | Minutes between background auto‑snapshots. |
| `maxAutoSnapshots` | `number` | `50` | Maximum number of rolling auto‑snapshots to retain. |
| `colorStrategy` | `"by-repo" \| "by-cwd" \| "rotate" \| "fixed"` | `"by-repo"` | How tab colors are auto‑assigned when you haven't chosen one. |
| `autoOpenBrowser` | `boolean` | `true` | Open the browser automatically on `dcs ui`. |
| `windowGrouping` | `"by-repo" \| "by-cwd" \| "single"` | `"by-repo"` | How discovered sessions are grouped into windows on restore. |
| `copilotCommand` | `string` | `"copilot"` | Executable used to launch/resume a session (e.g. `"agency"` to wrap Copilot with MCP servers). |
| `copilotArgs` | `string[]` | `[]` | Extra args inserted before `--resume` (e.g. `["copilot","--mcp","workiq",...,"--yolo"]`). |
| `restoreOnLogin` | `"off" \| "prompt" \| "auto"` | `"prompt"` | Logon task behavior: do nothing, open the dashboard to review/restore, or silently auto-restore the last snapshot. |

### Example `config.json`

```json
{
  "apiPort": 4517,
  "webPort": 4516,
  "snapshotIntervalMinutes": 5,
  "maxAutoSnapshots": 50,
  "colorStrategy": "by-repo",
  "autoOpenBrowser": true,
  "windowGrouping": "by-repo"
}
```

### Environment overrides

These environment variables override paths and ports (handy for tests and CI):

| Variable | Effect |
| --- | --- |
| `DCS_STATE_DIR` | Override the owned state directory (default `~/.durable-copilot-sessions/state`). |
| `DCS_COPILOT_HOME` | Override the Copilot home read from (default `~/.copilot`). |
| `DCS_API_PORT` | Override the API port for the Vite dev proxy. |
| `DCS_WEB_PORT` | Override the Vite dev server port. |
| `DCS_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default `info`). |

### On‑disk state layout

```
~/.durable-copilot-sessions/state/
├── config.json                  # AppConfig (this file)
├── registry/
│   ├── sessions/                # one ManagedSession JSON per customized session
│   └── workspaces/              # one Workspace JSON per saved layout
├── snapshots/                   # rolling auto-snapshots (pruned to maxAutoSnapshots)
├── launch-scripts/              # generated shell scripts wt.exe runs per tab
└── logs/                        # api-YYYY-MM-DD.log (JSON lines)
```

---

## Limitations

These are honest, by‑design trade‑offs — read them before relying on the tool.

- **No live‑tab introspection.** Windows Terminal exposes **no API** to read a live tab's color,
  title, or window grouping. Full‑fidelity "exact" restore therefore relies on metadata the tool
  records when you launch or customize a session **through** the tool (`dcs new`, `dcs resume`, or
  editing in the dashboard).
- **Auto‑discovered sessions restore approximately.** Sessions you never touched through the tool
  restore with their **name + cwd** and an **auto‑assigned color**, grouped into windows by
  **repository** by default. The exact original colors/titles of manually‑created tabs that predate
  tool adoption cannot be recovered.
- **Resume is cwd‑scoped.** Copilot's resume picker is scoped to a working directory, so each restored
  tab `cd`s to the session's recorded `cwd` before `copilot --resume`. If that cwd no longer exists,
  restore falls back to the git root, then the home directory, with a warning.
- **Read‑only on Copilot state.** The tool only **reads** `~/.copilot`; it never writes Copilot's
  state. It does not capture or replay Copilot conversation content — Copilot already persists that,
  and `dcs` only re‑attaches to it.
- **Windows‑only.** The tool drives `wt.exe`, so it is Windows‑only by nature.

---

## Development

Common scripts (see [`package.json`](package.json)):

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the API (`tsx watch`) and the Vite dashboard concurrently with hot reload. |
| `npm run dev:api` | Run just the Express API in watch mode. |
| `npm run dev:web` | Run just the Vite dev server. |
| `npm run build` | Build the Node code **and** the web bundle into `dist/`. |
| `npm run build:node` | Compile the Node/CLI/server code with `tsc`. |
| `npm run build:web` | Bundle the React dashboard with Vite. |
| `npm run typecheck` | Type‑check both the Node and web TypeScript projects (`--noEmit`). |
| `npm run lint` | Run ESLint across the repo. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run cli -- <args>` | Run the CLI from source via `tsx` (e.g. `npm run cli -- list`). |

### Conventions

- **TypeScript ESM** with `NodeNext` module resolution — relative imports use **`.js`** extensions
  (e.g. `import { loadConfig } from "./config.js"`).
- **No constructor parameter properties** (`erasableSyntaxOnly` is on); declare and assign fields
  explicitly.
- **Tests live beside source** as `*.test.ts` and run under **Vitest**.
- **Zero native dependencies.** SQLite enrichment uses Node's built‑in `node:sqlite` behind a
  try/catch, so it degrades gracefully where unavailable.

See [`AGENTS.md`](AGENTS.md) for the full contributor/agent guide.

### Project layout

```
src/
├── core/         # shared domain: types, paths, config, logger, discovery,
│   │             # registry, launch, snapshot
│   ├── types.ts  # the cross-layer contract (DiscoveredSession, Workspace, ...)
│   ├── paths.ts  # filesystem locations (Copilot read paths + owned state dir)
│   ├── config.ts # AppConfig defaults + load/save
│   └── snapshot/ # color assignment + window grouping
├── server/       # Express API (routes under /api)
├── web/          # React + Vite dashboard
├── cli/          # the `dcs` command set
└── scheduling/   # Windows Scheduled Task install/remove
```

---

## License

Private. © the project authors. All rights reserved.
