# Implementation Plan — Durable Copilot Sessions (dcs-001)

## Approach

A local TypeScript tool with four layers over a shared core:

```
              ┌─────────────── Web UI (React + Vite) ───────────────┐
              │  session list · one-click resume · save/restore     │
              └──────────────────────┬──────────────────────────────┘
                                     │ REST (/api)
              ┌──────────────────────▼──────────────────────────────┐
   CLI (dcs) ─┤            Local API server (Express)                │
              └──────────────────────┬──────────────────────────────┘
                                     │
     ┌───────────────┬───────────────┼────────────────┬─────────────┐
  discovery       registry        launch           snapshot      scheduling
 (read copilot   (owned JSON     (wt.exe +        (capture live  (Windows
  session state)  state store)    copilot resume)  layout)        Scheduled Tasks)
```

- **core/discovery** — scan `~/.copilot/session-state/*/workspace.yaml`, classify liveness from
  `inuse.<pid>.lock` + PID checks, flag top-level sessions, optional `node:sqlite` summary enrichment.
- **core/registry** — durable file-store: one JSON per managed session + one JSON per workspace,
  atomic writes, under `~/.durable-copilot-sessions/state/`.
- **core/launch** — build and run `wt.exe` to relaunch tabs running `copilot --resume`, with color
  map, window grouping, cwd-existence fallback. Pure argv builders are unit-tested via dry-run.
- **core/snapshot** — capture current live layout into a Workspace; restore relaunches it; rolling
  auto-snapshots with retention.
- **server** — Express API exposing sessions, workspaces, resume, snapshot, restore.
- **web** — React dashboard: live/known sessions, one-click resume, save/restore workspaces,
  per-session color/title editing.
- **cli** — `dcs list|resume|save|restore|snapshot|ui|serve|new|install-tasks|uninstall-tasks`.
- **scheduling** — install/remove Windows Scheduled Tasks: periodic `dcs snapshot` + logon restore
  prompt.

## Key decisions

- TypeScript ESM (NodeNext, `.js` import extensions), Vitest tests beside source.
- Zero native deps; `node:sqlite` used only as optional best-effort enrichment behind try/catch.
- Restore groups autodiscovered tabs into windows by `repository` by default (heuristic for the
  user's per-repo color/window habit); explicit saved workspaces preserve exact grouping.
- Never write to Copilot's state; treat `~/.copilot` as read-only.

## Work items (todos)

Foundation (done by lead): scaffold, types, paths, config, logger.

Wave 1 (parallel — depend only on core contracts):
- `core-discovery`, `core-registry`, `core-launch`

Wave 2 (parallel — depend on Wave 1):
- `core-orchestration` (snapshot/restore/resume facade), `server-api`, `web-ui`, `cli`,
  `scheduling`, `docs`

Verification: typecheck, lint, vitest, build, manual dry-run of resume/restore argv.

## Success criteria

1. `dcs list` shows live + recent Copilot sessions with name/cwd/repo/branch/liveness.
2. One-click resume (UI + `dcs resume <id>`) opens a WT tab that reattaches the session in its cwd.
3. `dcs save <name>` snapshots the current live layout; `dcs restore <name>` reopens all windows+tabs.
4. State persists under `~/.durable-copilot-sessions/state` and survives reboot.
5. `dcs install-tasks` registers periodic snapshot + logon restore-prompt scheduled tasks.
6. Web UI lists sessions and supports one-click resume + save/restore.
7. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass.
