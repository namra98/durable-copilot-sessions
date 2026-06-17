# AGENTS.md

Guidance for coding agents (and humans) working in **durable-copilot-sessions**. Keep changes small,
typed, and tested. When in doubt, mirror the patterns already in `src/core`.

## What this project is

A local, **Windows-only** tool that discovers Copilot CLI sessions, snapshots the Windows Terminal
layout, and restores the exact windows + tabs with each session resumed via `copilot --resume`.
Durable state lives on disk, so it survives reboots and forced Windows updates. See
[`README.md`](README.md) and [`docs/design/overview.md`](docs/design/overview.md) for the full
picture.

## Stack

- **TypeScript (ESM, `NodeNext`)** — Node `>=20`.
- **Express** local API server (default port **4517**).
- **Vite + React** web dashboard (dev port **4516**, proxies `/api` → API).
- **Vitest** for tests.
- **Zero native dependencies.** Optional SQLite enrichment uses the built-in `node:sqlite` behind a
  try/catch.

## Conventions

- **`.js` import extensions.** Because of `NodeNext`, relative imports must use the `.js` extension
  even for `.ts` files: `import { loadConfig } from "./config.js";`.
- **No constructor parameter properties.** `erasableSyntaxOnly` is enabled — declare class fields and
  assign them in the constructor body instead of using `constructor(private x: T)`.
- **Tests beside source** as `*.test.ts`, run with Vitest. Prefer pure, unit-testable functions
  (e.g. `wt.exe` argv builders are tested via dry-run rather than by spawning processes).
- **`core/types.ts` is the contract** between layers and must stay free of runtime imports so both
  Node and browser code can consume it.
- **Never write to `~/.copilot`.** Treat all Copilot state as **read-only**. Only write under the
  owned state directory (see below).
- **Atomic writes** for owned state: write to a temp file, then rename.
- Keep `strict` happy: `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` are all on. Prefix intentionally-unused args with `_`.

## Where things live

```
src/
├── core/         # shared domain logic (no Express/React here)
│   ├── types.ts        # cross-layer types — keep runtime-import-free
│   ├── paths.ts        # Copilot read paths + owned state dir (env-overridable)
│   ├── config.ts       # AppConfig defaults + load/save
│   ├── logger.ts       # JSON-lines logger → state/logs
│   ├── discovery/      # read ~/.copilot/session-state + liveness
│   ├── registry/       # durable JSON file-store (sessions + workspaces)
│   ├── launch/         # build/run wt.exe + copilot --resume
│   └── snapshot/       # capture/restore + color & window grouping
├── server/       # Express API, routes under /api
├── web/          # React + Vite dashboard
├── cli/          # the `dcs` command set (single index.ts, Commander)
└── scheduling/   # Windows Scheduled Tasks install/remove (+ hidden VBScript launcher)
```

## State directory

The tool owns `~/.durable-copilot-sessions/state/` (override with `DCS_STATE_DIR` for hermetic
tests). It contains `config.json`, `registry/sessions/`, `registry/workspaces/`, `snapshots/`,
`launch-scripts/`, and `logs/`. Copilot read paths are under `~/.copilot` (override with
`DCS_COPILOT_HOME`). See `src/core/paths.ts`.

## Run / test / build / lint

| Task | Command |
| --- | --- |
| Dev (API + dashboard, hot reload) | `npm run dev` |
| Type-check (Node + web) | `npm run typecheck` |
| Lint | `npm run lint` |
| Test (once) | `npm test` |
| Test (watch) | `npm run test:watch` |
| Build (Node + web) | `npm run build` |
| **All gates at once** | `npm run check` (typecheck + lint + test + build) |
| One-shot setup (install + build + link `dcs`) | `npm run setup` |
| Environment health check | `dcs doctor` |
| Run CLI from source | `npm run cli -- <args>` (e.g. `npm run cli -- list`) |

Before opening a PR, run `npm run check` — it runs `typecheck`, `lint`, `test`, and `build` in
sequence (the same gates CI enforces in `.github/workflows/ci.yml`).

## Commit conventions

Keep commits focused and descriptive. Include the Copilot co-author trailer on commits you make:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Documentation

Architecture and rationale live under `docs/design/`:

- [`docs/design/overview.md`](docs/design/overview.md) — architecture + data flow + state layout.
- [`docs/design/session-graph-canvas.md`](docs/design/session-graph-canvas.md) — the Session Graph
  (nodes/edges, fork lineage, co-located children) design.
