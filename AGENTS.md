# AGENTS.md

Guidance for coding agents (and humans) working in **durable-copilot-sessions**. Keep changes small,
typed, and tested. Backend/core changes should mirror the Rust patterns in `rust/dcs-core`.

## What this project is

A local, **Windows-only** tool that discovers Copilot CLI sessions, snapshots the Windows Terminal
layout, and restores the exact windows + tabs with each session resumed via `copilot --resume`.
Durable state lives on disk, so it survives reboots and forced Windows updates. See
[`README.md`](README.md) and [`docs/design/overview.md`](docs/design/overview.md) for the full
picture.

## Stack

- **Rust (MSRV 1.80)** for the primary backend/core, CLI, Axum API, scheduling helpers, and memory
  index. Unsafe code is forbidden.
- **TypeScript (ESM, `NodeNext`)** — Node `>=20` for the thin npm launcher and React dashboard.
- **Axum** local API server (default port **4517**).
- **Vite + React** legacy/dev dashboard (dev port **4516**, proxies `/api` → API).
- **Vitest** for dashboard/client tests and Cargo tests for Rust.

## Conventions

- **Rust first for backend/core.** Preserve serde names and on-disk JSON compatibility unless a
  migration is explicitly planned.
- **`.js` import extensions.** Because of `NodeNext`, relative TypeScript imports must use the `.js` extension
  even for `.ts` files: `import { loadConfig } from "./config.js";`.
- **No constructor parameter properties.** `erasableSyntaxOnly` is enabled — declare class fields and
  assign them in the constructor body instead of using `constructor(private x: T)`.
- **Tests beside source.** Rust integration tests live under `rust/**/tests`; dashboard TypeScript
  tests remain as `*.test.ts` and run with Vitest. Prefer pure, unit-testable functions.
- **`contracts/backend-api.v1.json` and `rust/dcs-core/src/model.rs` are the API/state contracts.**
  Keep web-facing TypeScript API types in sync when intentionally changing shapes.
- **Never write to `~/.copilot`.** Treat all Copilot state as **read-only**. Only write under the
  owned state directory (see below).
- **Atomic writes** for owned state: write to a temp file, then rename.
- Keep `strict` happy: `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` are all on. Prefix intentionally-unused args with `_`.

## Where things live

```
rust/
├── dcs-core/     # primary backend/domain library
│   ├── src/model.rs    # serde API/state contracts
│   ├── src/paths.rs    # Copilot read paths + owned state dir (env-overridable)
│   ├── src/discovery.rs
│   ├── src/registry.rs
│   ├── src/launch.rs
│   ├── src/manager.rs
│   └── tests/
└── dcs/          # `dcs-rs` CLI and Axum API server

src/
├── web/          # React + Vite dashboard client
└── cli/          # thin npm launcher that delegates to Rust
```

## State directory

The tool owns `~/.durable-copilot-sessions/state/` (override with `DCS_STATE_DIR` for hermetic
tests). It contains `config.json`, `registry/sessions/`, `registry/workspaces/`, `snapshots/`,
`launch-scripts/`, and `logs/`. Copilot read paths are under `~/.copilot` (override with
`DCS_COPILOT_HOME`). See `rust/dcs-core/src/paths.rs`.

## Run / test / build / lint

| Task | Command |
| --- | --- |
| Dev (API + dashboard, hot reload) | `npm run dev` |
| Type-check (Node + web) | `npm run typecheck` |
| Lint | `npm run lint` |
| Test (once) | `npm test` |
| Test (watch) | `npm run test:watch` |
| Build (Rust release + Node compatibility + web) | `npm run build` |
| Rust gates | `npm run rust:check` |
| Rust smoke | `npm run rust:smoke` |
| **All gates at once** | `npm run check` (typecheck + lint + test + Rust check + build) |
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
