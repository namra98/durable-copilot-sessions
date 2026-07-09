# Rust Backend Migration Plan

## Problem and approach

The current backend is a TypeScript/Express local service and CLI built around a synchronous core. The migration should make discovery, state access, launching, snapshots, and scheduling feel snappier without destabilizing the existing on-disk state or API contract that a future TUI will consume.

Use an incremental Rust migration: first freeze contracts and behavior with golden fixtures, then build a Rust core and HTTP/CLI surfaces alongside the TypeScript implementation, then cut over command by command and endpoint by endpoint. The React dashboard stays only as a contract consumer during the migration; porting or redesigning UI is out of scope.

## Research summary

- **Current architecture:** one TypeScript ESM codebase with shared `core`, Express `server`, React `web`, Commander `cli`, and Windows Scheduled Tasks integration (`docs\design\overview.md:16-63`, `src\server\index.ts:22-49`, `src\cli\index.ts:70-462`).
- **Contracts:** cross-layer types live in `src\core\types.ts`; the REST client mirrors them in `src\web\api\client.ts` and calls `/api` endpoints for sessions, graph, workspaces, config, snapshots, logs, stats, memory, transcript, diff, and fork/new session flows (`src\core\types.ts:20-202`, `src\web\api\client.ts:146-486`, `src\server\app.ts:26-255`).
- **State compatibility:** owned state is under `~\.durable-copilot-sessions\state` with config, registry JSON, snapshots, launch scripts, logs, and local memory DB; Copilot state is read from `~\.copilot` and should remain read-only (`src\core\paths.ts:13-55`, `docs\design\overview.md:114-144`, `README.md:41-45`).
- **Discovery hot path:** discovery scans `session-state` directories, reads `inuse.<pid>.lock` first, caches a filtered `tasklist` snapshot for `copilot.exe` and `node.exe`, and uses `liveOnly` to avoid parsing inactive `workspace.yaml` files for open/live views (`src\core\discovery\discovery.ts:88-124`, `src\core\discovery\discovery.ts:218-279`, `src\core\discovery\discovery.ts:390-421`).
- **Registry and snapshots:** managed sessions and workspaces are one JSON file per record, written atomically; snapshots are filename-sorted and pruned by retention (`src\core\registry\store.ts:27-62`, `src\core\registry\store.ts:93-102`, `src\core\registry\store.ts:242-271`).
- **Launch/restore:** Windows Terminal launch is via `wt.exe`; tabs run generated PowerShell scripts that `Set-Location` to the session cwd and invoke `copilot --resume <sessionId>`. Missing cwd falls back to git root/home with warnings (`src\core\launch\script.ts:19-40`, `src\core\launch\wt.ts:120-180`, `src\core\launch\launcher.ts:73-124`, `docs\design\decisions\0002-discovery-and-resume-model.md:40-47`).
- **Window grouping and fidelity:** Windows Terminal cannot be introspected for live tab title/color/window grouping, so full fidelity only exists for managed sessions; auto-discovered sessions use stable heuristic colors and grouping (`docs\design\decisions\0003-wt-restore-and-color-fidelity.md:21-39`, `src\core\snapshot\grouping.ts:30-97`).
- **Open-session semantics:** `annotateOpen` dedupes co-located live sessions by holder PID and chooses a primary per PID, which underpins open counts, session children, graph edges, and capture defaults (`src\core\snapshot\grouping.ts:106-178`, `src\core\manager.ts:156-198`).
- **Windows-only constraints:** environment checks require `wt`, PowerShell, Copilot CLI, Node currently, writable owned state, readable Copilot session-state, and scheduled task status (`src\core\doctor\doctor.ts:98-238`). Scheduling shells out to `schtasks.exe` and can use hidden VBScript launchers (`src\scheduling\schtasks.ts:51-123`, `src\scheduling\tasks.ts:57-149`, `src\scheduling\hidden.ts:26-38`).
- **Validation gates:** current gates are `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and combined `npm run check` (`package.json:13-28`, `README.md:418-435`). Existing tests cover server routes, discovery, manager behavior, launcher argv/scripts, registry, graph, memory, stats, export/import, scheduling, and web helper logic.

## Key migration decisions

1. **Ship a Rust backend beside TypeScript before replacing it.** Add a Rust crate/workspace and run it under feature-gated or alternate commands until endpoint and CLI parity is proven.
2. **Freeze current state and API as compatibility contracts.** Treat `Workspace`, `ManagedSession`, `AppConfig`, `LaunchResult`, session discovery fields, graph/memory/stats payloads, and workspace export envelope as versioned contracts.
3. **Preserve on-disk state by default.** Rust reads and writes the same JSON file layout and path environment overrides. Any incompatible schema change must be opt-in and include a migration/rollback path.
4. **Keep Copilot state read-only except documented stale-lock cleanup/fork behavior.** The current code has a narrow stale lock removal and session fork path; Rust should retain the same boundaries and make them explicit.
5. **Use Rust for hot paths first.** Discovery, open-session annotation, registry IO, workspace diff, and launch script/argv builders are the speed-sensitive core; memory indexing and dashboard serving can follow after core parity.
6. **Document API contract for the future TUI.** Generate or maintain a machine-readable contract plus human docs so the TUI can bind to stable endpoints without depending on the React dashboard.

## Implementation progress

- Contract freeze and Rust workspace scaffold are complete. The checked-in contract is `contracts\backend-api.v1.json`; golden fixtures live under `tests\fixtures\contracts\`.
- Rust core parity is implemented for contract models, session discovery, open-session graph annotation, registry/config/snapshot/workspace export/diff, Windows Terminal launch planning, memory indexing/search, and stats rollups.
- Rust HTTP API compatibility is implemented with Axum and covered by fixture-backed tests for session/graph ordering, response envelopes, config/logs/memory/workspace wrappers, fork creation, and new-session dry-run launch planning.
- Rust CLI/scheduling parity is implemented in `dcs-rs`, including the existing command surface, doctor checks, Windows Scheduled Tasks argument builders, hidden VBScript launchers, and fixture-backed CLI smoke tests.
- Validation/benchmark smoke gates are implemented via `npm run rust:smoke`, which exercises large-tree live-only discovery performance, and `npm run rust:check`, which covers formatting, clippy, tests, and build.
- Remaining migration work is cutover packaging/docs.

## Staged work items

### Stage 0 - Contract freeze and parity harness

- Inventory REST endpoints, CLI commands, request/response payloads, state file schemas, and environment variables.
- Add golden fixture data for Copilot session-state, owned registry/snapshots/config/logs, workspace exports, and scheduled task command strings.
- Add contract tests that can run both TypeScript and Rust implementations against the same fixtures.
- Produce a TUI-facing API contract document/OpenAPI-style artifact that reflects current `/api` behavior.

### Stage 1 - Rust workspace and core model scaffold

- Add a Rust workspace/crate layout without removing TypeScript code.
- Define Rust equivalents of core domain types with `serde` compatibility for current JSON field names.
- Add Rust test fixtures and CI/build commands alongside existing `npm run check`.
- Decide packaging shape: a single `dcs` Rust binary with subcommands plus an embedded local HTTP server is preferred over many small binaries.

### Stage 2 - Rust discovery and open-session model

- Port Copilot session discovery: `workspace.yaml` parsing, lock file scanning, PID liveness/process image filtering, `liveOnly` short-circuiting, sorting, summary enrichment seam, and single-session lookup.
- Port `annotateOpen` and graph relationship inputs exactly, including primary/child semantics.
- Benchmark fixture-backed discovery against the TypeScript implementation and a large synthetic session-state tree.

### Stage 3 - Rust owned state and pure core operations

- Port config load/save, registry JSON IO, atomic writes, safe ID handling, snapshot retention, workspace export/import validation, workspace diff, colors/grouping, stats/read-only SQLite rollups, and local memory store strategy.
- Preserve `DCS_STATE_DIR` and `DCS_COPILOT_HOME`.
- Decide SQLite implementation for Rust. Prefer a stable bundled or statically linked option only after validating install/build friction; memory/stat features can remain behind a compatibility fallback until chosen.

### Stage 4 - Rust launch, restore, and Windows integration

- Port `wt.exe` argv generation, PowerShell launch script rendering, PATHEXT executable resolution, cwd fallback warnings, launch preflight, and dry-run seams.
- Port scheduled task install/uninstall/status and hidden launcher generation.
- Port doctor checks, updating Node-specific checks only after the Rust binary can run without Node.

### Stage 5 - Rust HTTP API compatibility layer

- Implement the same `/api` routes and status/error behavior using a Rust HTTP stack.
- Keep response envelopes and error strings stable where consumers assert or display them.
- Run the existing React API client tests against the Rust server or a generated contract fixture; do not port the dashboard.

### Stage 6 - Rust CLI parity and bridge cutover

- Port CLI subcommands from Commander to Rust, keeping command names/options and output semantics stable.
- Initially allow the npm `dcs` bin to delegate to the Rust binary or expose `dcs-rs` for side-by-side validation.
- Cut over one group at a time: read-only list/stats/logs/doctor, then workspaces/snapshots, then launch/restore/fork/scheduling.

### Stage 7 - Packaging, docs, and deprecation

- Update install/setup scripts for Rust binary build or release artifact download on Windows.
- Update architecture docs and ADRs to describe the Rust backend, preserved state contract, and dashboard/TUI contract.
- Keep TypeScript web code as a temporary API consumer. Remove or deprecate TypeScript server/core only after Rust parity and validation gates pass.

## SQL todo set

The PAW Lite coordination todos mirror the staged migration. Independent early work should be parallelizable after contract fixtures are in place.

| Todo ID | Title | Depends on |
| --- | --- | --- |
| `contract-freeze` | Freezing backend contracts | none |
| `rust-workspace-scaffold` | Scaffolding Rust workspace | `contract-freeze` |
| `rust-domain-state` | Porting domain types and state formats | `contract-freeze`, `rust-workspace-scaffold` |
| `rust-discovery` | Porting discovery hot path | `rust-domain-state` |
| `rust-registry-core` | Porting registry, config, snapshots, diff, export | `rust-domain-state` |
| `rust-launch-windows` | Porting Windows launch and restore integration | `rust-domain-state` |
| `rust-http-api` | Implementing Rust HTTP API compatibility | `rust-discovery`, `rust-registry-core`, `rust-launch-windows` |
| `rust-cli-scheduling` | Implementing Rust CLI, doctor, and scheduled tasks | `rust-discovery`, `rust-registry-core`, `rust-launch-windows` |
| `rust-memory-stats` | Porting memory and stats capabilities | `rust-registry-core` |
| `validation-benchmarks` | Validating parity and measuring performance | `rust-http-api`, `rust-cli-scheduling` |
| `cutover-docs-packaging` | Cutting over packaging and docs | `validation-benchmarks`, `rust-memory-stats` |

## Critical questions and assumptions

- **SQLite strategy:** current TypeScript uses `node:sqlite` as a best-effort built-in. Rust needs a deliberate SQLite crate/linking choice, or memory/stat features should remain fallback/optional until that choice is validated.
- **API contract source of truth:** future TUI work needs either generated OpenAPI/JSON schema or a checked-in contract test fixture. The plan assumes adding this during Stage 0 is acceptable.
- **Cutover shape:** the safest default is side-by-side Rust (`dcs-rs` or npm delegating to Rust) before removing TypeScript server/core. A direct replacement should wait until parity tests and benchmark gates are green.
- **State migrations:** assume no state format changes for initial cutover. If Rust reveals schema gaps, add versioned migration commands rather than silently rewriting existing state.
- **Frontend scope:** dashboard code is not migrated. It may be used only to validate `/api` compatibility until the future TUI consumes the same contract.

## Validation plan

- Keep existing TypeScript gates during side-by-side work: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run check`.
- Add Rust gates once scaffolded: `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all`, and release build for Windows.
- Add dual-implementation contract tests for discovery fixtures, registry JSON roundtrips, workspace export/import, `wt.exe` argv rendering, scheduled task args, REST routes, and CLI command outputs.
- Add benchmark/smoke scripts focused on large session-state discovery, `/api/sessions?filter=open`, `/api/graph?filter=open`, snapshot creation, and workspace restore dry-run.
