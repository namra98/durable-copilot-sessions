# 4. Rust backend migration

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** project authors

## Context

The original TypeScript/Express backend proved the workflow, but session discovery, graph
annotation, memory indexing, launch planning, and API response paths need to feel snappier as the
number of Copilot sessions grows. A separate TUI is planned, so backend correctness and contract
stability matter more than porting the current React dashboard.

The tool must keep:

- Windows-only `wt.exe` and Scheduled Tasks integration;
- read-only access to `~/.copilot` by default;
- owned state compatibility under `~/.durable-copilot-sessions/state`;
- the existing `/api` JSON shape consumed by web/TUI clients.

## Decision

Migrate the backend/core and CLI to Rust incrementally:

- `rust/dcs-core` owns discovery, registry/state IO, launch/snapshot planning, memory/search, stats,
  logs/transcripts, scheduling helpers, doctor checks, and the manager facade.
- `rust/dcs` provides the `dcs-rs` CLI and Axum `/api` server.
- The npm-linked `dcs` command is a thin Node launcher that delegates to `target\release\dcs-rs.exe`
  after `npm run build`.
- `contracts/backend-api.v1.json` and golden fixtures freeze API/state behavior while TypeScript and
  Rust coexist.
- The React dashboard remains a legacy/dev client of the frozen API contract; future TUI work should
  consume the same contract rather than depending on TypeScript internals.

## Consequences

**Positive**

- Discovery, API, memory, and CLI paths are implemented in a single compiled backend.
- Rust tests cover API envelopes, state formats, launch planning, scheduling, and smoke-scale
  discovery without needing live Windows Terminal windows.
- The on-disk state layout remains compatible, so users do not need a state migration for this cutover.

**Negative / trade-offs**

- Development now requires a Rust toolchain in addition to Node.
- The convenience `dcs` npm command still needs Node because npm links JavaScript shims; users can run
  `target\release\dcs-rs.exe` directly if they want a Node-free runtime path.
- The legacy React dashboard is not ported into the Rust server. It remains available through Vite
  during development and should be replaced by the planned TUI.
