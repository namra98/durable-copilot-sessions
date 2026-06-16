# Design: Session Graph / Canvas

- **Status:** Proposed (design only — no code in this document)
- **Date:** 2026-06-16
- **Scope:** A new node-graph view in the `dcs` dashboard where the user **sees** Copilot
  sessions as nodes and their relationships as edges, and can **create**, **fork**, and
  **resume** sessions directly from the canvas.
- **Audience:** maintainers of `durable-copilot-sessions`.
- **Related:** [overview](overview.md), [ADR 0002 — discovery & resume](decisions/0002-discovery-and-resume-model.md),
  [ADR 0003 — wt restore & color fidelity](decisions/0003-wt-restore-and-color-fidelity.md).

---

## 1. Motivation & ground truth

Today the dashboard is a **flat list** with three tabs (Open / Live / All) backed by
`GET /api/sessions?filter=…`. It answers "what sessions exist and which terminals are open"
but hides **structure**: which session was forked from which, and which subagent/child
sessions a live terminal is driving. A canvas turns that latent structure into something
spatial and actionable.

### Lineage is genuinely readable (verified)

Three independent relationships exist on disk and can be reconstructed read-only:

1. **Fork lineage (durable, explicit).** Copilot normally writes **no** parent link in
   `workspace.yaml`. But the installed **`session-branch`** skill forks a session by copying
   its directory, minting a new id, and rewriting `workspace.yaml` to add custom fields
   **`branch_of: <parentSessionId>`** and **`branch_note`** (plus `name: "Branch: <orig>
   [<prefix>]"`, `user_named: true`). Copilot **preserves** these fields. So fork lineage is
   a direct parent→child read from `branch_of`.
   - Script: `~/.copilot/installed-plugins/lossyrob-skills/.../skills/session-branch/scripts/branch_session.py`
     (Python 3, stdlib-only). It also resets `rewind-snapshots/` + `checkpoints/`, drops
     `session.db` and stale `inuse.*.lock`, copies `events.jsonl`, and rewrites the
     `session.start` event's `sessionId`/title so the branch resumes cleanly.

2. **Terminal co-location (live, ephemeral).** One `copilot.exe` PID holds an
   `inuse.<pid>.lock` on every session it spawned (the foreground session **plus** its
   subagent/background children). `annotateOpen()` in `core/snapshot/grouping.ts` already
   computes, per terminal: `roleById` (primary | child), `groupPidById`, `childrenById`, and
   the honest `openCount`. This is the second edge source — **for free**.

3. **Project grouping (static).** Sessions sharing `repository` / `gitRoot` / `cwd` belong to
   the same project. This is an optional clustering signal, not a true edge.

### Why a canvas (opinionated)

- Fork lineage is a **tree**; a list cannot show "this is the 3rd branch off that
  investigation." A graph makes branch families legible at a glance.
- "Open a child terminal next to its parent" and "fork this and start exploring" are
  inherently spatial gestures. The canvas makes creation a first-class action, not a
  list-row afterthought.

---

## 2. Graph data model

A new pure core module **`core/graph/`** derives a serializable graph from the existing
`DiscoveredSession[]` + the `annotateOpen()` annotation. No new disk reads beyond the
discovery change in §3.

### Types (add to `core/types.ts`)

```ts
/** Why two sessions are connected. */
export type GraphEdgeKind =
  | "fork"      // parent -> branch, from workspace.yaml `branch_of`. Solid.
  | "terminal"  // primary -> child (subagent/background), from annotateOpen. Dashed.
  | "repo";     // optional repo-cluster membership edge (cluster anchor -> member). Faint.

export interface GraphNode {
  id: CopilotSessionId;
  /** Display label: managed title ?? name ?? short id. */
  label: string;
  repository?: string;
  branch?: string;
  cwd: string;
  cwdExists: boolean;
  color: string;                 // resolved tab color (managed override or strategy hash)
  liveness: SessionLiveness;     // live | stale | inactive
  role?: "primary" | "child";    // from annotateOpen (live sessions only)
  branchOf?: CopilotSessionId;   // present on forked sessions
  branchNote?: string;
  childCount?: number;           // primaries: number of co-located children
  forkChildCount: number;        // number of sessions whose branchOf === this.id
  /** True when branchOf points at an id we never discovered (parent pruned/elsewhere). */
  orphanedFork?: boolean;
}

export interface GraphEdge {
  id: string;                    // stable: `${kind}:${source}->${target}`
  kind: GraphEdgeKind;
  source: CopilotSessionId;      // parent / primary / cluster anchor
  target: CopilotSessionId;      // branch / child / member
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Repo -> member ids, for cluster rendering & the repo filter. */
  clusters: { key: string; label: string; nodeIds: CopilotSessionId[] }[];
  openCount: number;             // pass-through from annotateOpen
}
```

### Derivation (`core/graph/buildGraph.ts`, pure & unit-testable)

Input: `sessions: DiscoveredSession[]`, `managedById`, `config` (for color), and the result
of `annotateOpen(sessions)`. Algorithm:

1. **Nodes.** One `GraphNode` per session. `color` reuses the existing `colorFor()` /
   managed-override logic from `grouping.ts` (do not reinvent). `forkChildCount` is computed
   by counting sessions whose `branchOf === id`. `role`/`childCount` come from the
   annotation.
2. **Fork edges.** For each session with `branchOf` set: if the parent id is in the node set,
   emit `{ kind:"fork", source:branchOf, target:id }`; otherwise mark the node
   `orphanedFork = true` (the canvas still shows the badge, just with no incoming edge).
3. **Terminal edges.** For each `primary p` and each child `c` in `childrenById.get(p)`, emit
   `{ kind:"terminal", source:p, target:c }`. These exist only for `live` sessions.
4. **Repo edges/clusters.** Group nodes by `repository ?? gitRoot ?? cwd`. Build `clusters[]`.
   Repo **edges** are optional and **off by default** (they explode density); the cluster is
   primarily a layout/visual-grouping hint and the backing data for the repo filter.

**Determinism:** nodes and edges are emitted in a stable order (sessions are already sorted
live-first then `updatedAt` desc by discovery), so snapshot tests and dagre layout are stable.

**Edge precedence:** fork and terminal edges are independent and may coexist between the same
pair (rare but possible: a live branch driven by the same terminal as its parent). Keep both;
they render differently. De-dupe only within a kind via the `id`.

---

## 3. Discovery change

Extend the read-only discovery to surface the two custom fields. Minimal, additive, and
backward-compatible.

In `core/discovery/discovery.ts`:

- Extend the raw `WorkspaceYaml` interface with `branch_of?: unknown` and
  `branch_note?: unknown`.
- In `readSession(...)`, add to the returned `DiscoveredSession`:
  ```ts
  branchOf: optionalString(workspace.branch_of),
  branchNote: optionalString(workspace.branch_note),
  ```

In `core/types.ts`, add to `DiscoveredSession`:

```ts
/** Parent session id, when this session was created by the session-branch skill. */
branchOf?: CopilotSessionId;
/** Free-text note recorded at branch time, e.g. "Branched from: <title> (<id>)". */
branchNote?: string;
```

Notes:
- `branchOf` is read for **every** parsed session — including the `liveOnly` fast path, since
  those still parse `workspace.yaml`. No extra I/O.
- The `all` filter is what surfaces *inactive* forks; lineage of a long-dead branch is still
  visible. The graph endpoint (next section) decides which slice to materialize.

---

## 4. API

Three endpoints, wired through the `SessionManager` façade so the CLI can reuse them and so
tests can inject fakes (mirrors the existing pattern in `core/manager.ts`).

### 4.1 `GET /api/graph?filter=open|live|all`

Returns a `GraphModel`. Implementation: `manager.buildGraph(filter)` calls `discover({ liveOnly: filter !== "all" })`,
runs `annotateOpen`, then `buildGraph(...)`. Same filter semantics as `/api/sessions`:

- `open` (default) — primaries only as "anchor" nodes, but **fork children are always pulled
  in** even if inactive, so a tree is never truncated mid-branch. Concretely: start from the
  open/live set, then transitively include any `branchOf` ancestors/descendants found in the
  full parse. (For `open`/`live` we still parse only live dirs; ancestors that are inactive
  are fetched on demand via `getSession(id)` — cheap, single-dir reads.)
- `live` — all `live` sessions + their fork relatives.
- `all` — every parsed session (the 1000+ case; see §7 for the guardrails).

Response shape: `{ graph: GraphModel }`.

### 4.2 `POST /api/sessions/:id/fork`

Body: `{ note?: string; launch?: boolean; color?: string; window?: "new" | "current" }`.

Forks session `:id` (see §5), then:
- if `launch !== false`, resume the **new** session immediately by reusing
  `manager.resume({ sessionId: newId, color, window, cwd: <parent cwd> })`. Because the fork
  created the dir + id on disk first, `copilot --resume <newId>` attaches to the branch
  directly — no "pick from list" step.
- Returns `{ session: SessionView, launch?: LaunchResult }` where `session` is the freshly
  discovered branch node (so the UI can drop it onto the canvas with its `branchOf` edge).

Validation: 404 if `:id` is unknown; 409 if the computed destination dir already exists.

### 4.3 `POST /api/sessions/new`

Body: `{ title: string; cwd: string; color?: string; prompt?: string; window?: "new" | "current" }`.

Launches a **brand-new** Copilot session in a WT tab — exactly what the existing `dcs new`
CLI command does (`renderNewSessionScript` → `buildWindowArgs("new", …)` → `wt.exe`). Key
asymmetry vs. fork: Copilot mints the id **after** it starts, so the server cannot return a
session id synchronously. Response: `{ launch: LaunchResult }`. The canvas adds a transient
"pending new session" placeholder node and reconciles it on the next `GET /api/graph`
auto-refresh (match by `cwd` + recent `createdAt`).

> Reuse, don't duplicate: `resume` stays the single source of truth for the launch path. Fork
> and new only differ in *what* they hand to the launcher (an existing id vs. a fresh
> `copilot` invocation).

### Manager additions

```ts
class SessionManager {
  buildGraph(filter: SessionFilter = "open"): GraphModel;
  forkSession(id: string, opts: ForkOptions): { session: SessionView; launch?: LaunchResult };
  newSession(opts: NewSessionOptions): LaunchResult;
}
```

`ForkOptions = { note?, launch?, color?, window? }`. `NewSessionOptions = { title, cwd,
color?, prompt?, window? }`. CLI gains `dcs fork <id>` and the existing `dcs new` is unchanged.

---

## 5. Fork implementation — options & recommendation

Forking must produce a session directory that **resumes cleanly** and **carries `branch_of`**.

### What a correct branch requires (the contract)

Derived directly from `branch_session.py`. A new dir under `~/.copilot/session-state/<newId>/`
that is a copy of the parent with these mutations:

1. **`workspace.yaml` identity & lineage:** set `id: <newId>`,
   `name: "Branch: <baseTitle> [<newId[:8]>]"`, `user_named: true`,
   `summary: <branchTitle>`, fresh `created_at`/`updated_at` (UTC ISO, `…Z`), and append
   `branch_of: <parentId>` + `branch_note`. Must not introduce duplicate top-level keys.
2. **`events.jsonl` (history):** copy verbatim, then rewrite the `session.start` event's
   `data.sessionId → newId`, set `alreadyInUse:false`, and update any `name`/`title`/`summary`
   to the branch title. If absent, skip (older sessions may have none).
3. **Reset transient state:** recreate `rewind-snapshots/index.json` to the empty-snapshot JSON
   and clear `rewind-snapshots/backups/*`; recreate `checkpoints/index.md` with the header
   template (drops the parent's checkpoint/rewind history so they don't bleed across).
4. **Drop per-instance state:** delete `session.db` and every `inuse.*.lock` (otherwise the
   branch looks "live"/locked and Copilot may refuse or contend).
5. **Atomicity:** stage in a sibling temp dir and rename into place, so a crash never leaves a
   half-branched session under `session-state/`.

If 1, 4, and 5 are wrong, the branch may fail to resume or corrupt the picker; 2 and 3 affect
*correctness of history*, not just resume.

### Option A — shell out to the installed `branch_session.py`

Locate it dynamically (glob `~/.copilot/installed-plugins/**/session-branch/scripts/branch_session.py`),
resolve a Python 3 interpreter (`py -3` → `python` → `python3`), and
`spawnSync(py, [script, parentDir, newDir, parentId, newId])`. Parse the printed
`NEW_SESSION_ID/NAME/PATH`.

- **Pros:** battle-tested; handles block-scalar YAML, `events.jsonl` rewrite, atomic rename,
  duplicate-key validation. Zero re-implementation risk.
- **Cons:** requires **Python 3** on PATH (not guaranteed) **and** the skill to be installed at
  a discoverable path (it may be absent or move). Violates the project's "zero external runtime
  deps / pure TypeScript" ethos and its read-only-Python-free posture. Brittle to skill-version
  drift.

### Option B — reimplement branching in TypeScript

Use Node `fs` + the already-present **`yaml`** dependency. Steps mirroring the contract:

1. `fs.cpSync(parentDir, stagingDir, { recursive: true })` into a sibling
   `.tmp-branch-<uuid>` dir.
2. **Rewrite `workspace.yaml` with `yaml`'s `parseDocument`** (CST-preserving) rather than
   `parse`+`stringify`: load the document, `doc.set("id", newId)`, set `name`, `user_named`,
   `summary`, `created_at`, `updated_at`, `branch_of`, `branch_note`, then `doc.toString()`.
   `parseDocument` preserves unrelated keys, comments, and block scalars, which a naive
   `parse → stringify` round-trip would mangle. Guard against duplicate top-level keys.
3. **`events.jsonl`:** if present, stream line-by-line, JSON-parse each, and on
   `type === "session.start"` patch `data.sessionId`/`alreadyInUse`/title fields; re-emit
   compact JSON.
4. **Reset rewind/checkpoints:** write the empty `rewind-snapshots/index.json`, clear
   `backups/`, write the `checkpoints/index.md` header.
5. **Drop** `session.db` + `inuse.*.lock`.
6. **Atomic-ish rename:** `fs.renameSync(stagingDir, newDir)`. On Windows, rename within the
   same volume is atomic for a directory **only if the destination does not exist** — which we
   guarantee (newId is a fresh UUID). On `EXDEV`/`EPERM`/`EEXIST`, clean up staging and surface
   a clear error.

- **Pros:** pure TS, no Python, no skill dependency — fits the codebase. Fully unit-testable
  with a temp `DCS_COPILOT_HOME`. We control the format contract.
- **Risks / what to watch:**
  - **YAML fidelity.** `parseDocument` is the safe path; a `parse → stringify` shortcut risks
    reordering keys or losing block scalars. Must use the document/CST API and add a snapshot
    test against a real `workspace.yaml`.
  - **`events.jsonl` schema drift.** Patch only the fields we understand; never drop unknown
    keys. Wrap in try/catch per line so one malformed line can't abort the fork (copy verbatim
    on parse failure).
  - **Windows rename atomicity & AV/file-locking.** A virus scanner or Explorer handle on the
    copied tree can cause `EPERM` on rename; retry briefly, else fail loudly (don't leave
    staging behind).
  - **Format coupling.** Same caveat ADR 0002 already accepts — we depend on Copilot's on-disk
    layout. Centralize the constants (index.json/index.md templates) so a format bump is a
    one-file change.
  - **We are now *writing* under `~/.copilot`.** This breaks the long-standing "only ever read
    Copilot state" invariant. It must be **scoped strictly to creating a brand-new
    `<newId>/` directory** — never mutating an existing session. Document this prominently
    (update the README's read-only claim and overview).

### Recommendation — **Option B (TS-native) with a documented Option A fallback (hybrid)**

Ship a TS-native `core/branch/branchSession.ts` as the default. It removes the Python and
skill-path dependencies and keeps the build pure. Implement Option A as an **opt-in fallback**
(`DCS_BRANCH_USE_SKILL=1`, or auto-fallback if the TS branch throws a YAML/format error *and*
the script is present) so power users keep the battle-tested path during early hardening. Gate
B behind a comprehensive test suite (round-trip a captured fixture session and assert it
discovers with the right `branchOf` and resumes in dry-run).

This is the only option consistent with the project's stated principles (§ "zero native
dependencies", "pure TypeScript") while preserving an escape hatch.

> **Invariant change (must be called out in review):** introducing fork makes `dcs` a *writer*
> of new session directories under `~/.copilot/session-state/`. It still never edits an
> existing Copilot session. Update overview.md and the README accordingly.

---

## 6. Frontend — the "Graph" tab

### Stack

Add two pure-JS, installable deps (same stack the "stack streamliner" uses):

- **`@xyflow/react` v12** — React Flow: nodes/edges, pan/zoom/drag, minimap, controls,
  custom node & edge components, context menus.
- **`@dagrejs/dagre` v3** — directed-graph auto-layout (top-down tree for fork lineage).

Both are browser-only and tree-shakeable; they land in `dependencies` and only affect the web
bundle, not the Node build. No native deps — consistent with §1.

### Where it lives

A **fourth tab** alongside Open / Live / All in the existing `nav.tabs` of `App.tsx`:
`Open · Live · All · Graph`. Selecting **Graph** swaps the list `<main>` for a full-bleed
`<GraphCanvas/>`. The Open/Live/All tabs are unchanged; the canvas is **additive** and shares
the same `filter` + `windowTarget` state and the same toast/`reportLaunch` plumbing, so resume
feedback is identical across views. The repo/search Toolbar is replaced in Graph mode by a
canvas-specific toolbar (below).

### Components

```
web/graph/
  GraphCanvas.tsx      // ReactFlow host: data load, layout, selection, context menu
  SessionNode.tsx      // custom node
  edgeStyles.ts        // per-kind edge styling + markers
  layout.ts            // dagre wrapper: GraphModel -> positioned nodes/edges
  GraphToolbar.tsx     // "+ New session", layout direction, filter, legend toggle
  api additions in web/api/client.ts: getGraph(filter), forkSession(id, body), newSession(body)
```

**`SessionNode`** (custom React Flow node):
- Left **color border** = `node.color` (reuses `resolveColor`).
- **Liveness:** `live` → soft pulsing dot; `stale` → muted amber ring; `inactive` → flat/greyed.
- **Title + repo/branch** subline; truncates with tooltip.
- **Badges:** fork badge `⑂ branchOf` when `branchOf` set; `n` fork-children when
  `forkChildCount>0`; child/primary badge + `childCount` from the terminal annotation;
  `orphanedFork` shows a dim "parent not found" hint.
- **Primary action:** a **Resume** button (▶) — same call as the list's `handleResume`.
- **Context menu** (right-click or ⋯): **Resume** · **Fork…** (prompts for optional note,
  then `POST …/fork`) · **New child** (open a co-located terminal in the same cwd via
  `POST /api/sessions/new`) · **Recolor** (reuse `ColorPopover`, `PATCH /api/sessions/:id`) ·
  **Open folder** (reveal `cwd` — best-effort, no-op if `!cwdExists`).

**Edges (`edgeStyles.ts`)** — visually distinct per kind, with a **legend**:
- `fork` — **solid**, arrowhead, accent color → "forked from".
- `terminal` — **dashed**, lighter → "subagent / co-located in one terminal".
- `repo` — **faint/dotted**, off by default → "same repository".

**Layout (`layout.ts`)** — feed `GraphModel` to dagre with `rankdir` from the toolbar
(`TB` default, `LR` optional). Fork edges drive the hierarchy (they form the tree); terminal
edges are added as lighter constraints; repo membership becomes optional cluster framing
(dagre clusters or just convex-hull background tints). React Flow handles pan/zoom/drag; a
node's manual drag is preserved until the next explicit "re-layout".

**`GraphToolbar`** — `+ New session` (modal: title, cwd, color, optional prompt → `newSession`);
layout-direction toggle (TB/LR); the open/live/all filter (shared with the tabs); a legend
toggle; "Fit view" / re-layout. `windowTarget` (new/current) stays in the header.

### Data & refresh

The canvas calls `getGraph(filter)` on mount and reuses the existing 15s auto-refresh cadence
(`AUTO_REFRESH_MS`). To avoid yanking the viewport, **merge** incoming nodes onto existing
positions (only run dagre for newly-appeared nodes or on explicit re-layout). Fork/new
optimistically insert a node, then reconcile on the next fetch.

### Coexistence summary

| Concern | List tabs (Open/Live/All) | Graph tab |
| --- | --- | --- |
| Backing endpoint | `GET /api/sessions` | `GET /api/graph` |
| Filter | shared `filter` state | shared `filter` state |
| Resume / patch | `handleResume` / `handlePatch` | same handlers, called from node |
| New / Fork | (list has none) | `+ New`, node context menu |
| Toolbar | search/sort/group | layout/filter/legend/+New |

---

## 7. Risks

- **Fork correctness** (highest). Covered in §5: YAML fidelity, `events.jsonl` rewrite,
  Windows rename atomicity, and the read-only-invariant change. Mitigation: TS-native impl
  behind a fixture round-trip test + dry-run resume assertion, with the Python script as an
  opt-in fallback.
- **Large graphs (1000+ "all" sessions).** A flat all-sessions graph is unreadable and slow to
  lay out. Mitigations: **default the Graph tab to `open`/`live`**, not `all`; make the **repo
  filter** prominent; lazily expand a fork subtree on demand; cap rendered nodes (e.g. 300)
  with a "showing N of M — narrow the filter" banner; run dagre only on
  add/expand/explicit-relayout, never every 15s refresh.
- **Performance.** React Flow + dagre handle a few hundred nodes comfortably; beyond that,
  enable React Flow's `onlyRenderVisibleElements`, memoize node components, and debounce
  layout. Keep `buildGraph` pure and O(n) (single passes for fork/terminal/cluster maps).
- **Stale lineage / orphans.** A `branch_of` may point to a pruned/relocated parent →
  `orphanedFork` node with no incoming edge (handled gracefully, badge only).
- **Windows specifics.** `wt.exe`/`copilot` on PATH (existing preflight covers this); Python
  may be absent (drives the Option-B default); AV/Explorer handles can lock the copied tree
  during rename (retry + clear error); long paths under `session-state` (use `\\?\` extended
  paths if `EINVAL` appears on deep trees).
- **New-session id latency.** `POST /api/sessions/new` can't return an id synchronously
  (Copilot mints it). Handled by the pending-placeholder + reconcile-on-refresh pattern.
- **Concurrent fork of a live parent.** Branching copies a live session's tree while it may be
  writing. We drop `session.db`/locks in the copy, so the branch is consistent enough to
  resume, but warn (like `resume` already warns) that forking a busy session captures a
  point-in-time copy.

---

## 8. Phased plan & effort

Estimates are relative (1 pt ≈ a focused half-day), assuming the existing test harness.

### P0 — Visualize + resume + new  *(~5–7 pts)*
- Discovery: add `branchOf`/`branchNote` (§3). *(1)*
- `core/graph/buildGraph.ts` + types + unit tests. *(1.5)*
- `GET /api/graph` + `manager.buildGraph` + `POST /api/sessions/new` (wrap existing `new`). *(1)*
- Web: add deps, **Graph tab**, `GraphCanvas`, `SessionNode`, dagre layout, resume from node,
  `+ New session`, legend. *(2.5)*
- **Outcome:** see the lineage that already exists (terminal co-location + any pre-existing
  `branch_of`), resume from the canvas, create new sessions. No writing to `~/.copilot` yet.

### P1 — Fork with lineage  *(~4–6 pts)*
- `core/branch/branchSession.ts` (Option B) + fixture round-trip tests + dry-run resume. *(3)*
- Optional Python fallback (Option A) behind `DCS_BRANCH_USE_SKILL`. *(1)*
- `POST /api/sessions/:id/fork` + `manager.forkSession` + `dcs fork <id>`. *(1)*
- Node **Fork…** action + optimistic edge insertion; README/overview invariant update. *(1)*
- **Outcome:** fork from the canvas; the branch appears with a solid fork edge and resumes.

### P2 — Children, drag-to-link, saved layouts  *(~5–8 pts)*
- **New child** action (co-located terminal in same cwd) + clearer primary↔child rendering. *(1.5)*
- **Drag-to-link:** dragging node A onto B triggers "Fork A from B?" / grouping affordances. *(2)*
- **Saved canvas layouts:** persist node positions/zoom per filter (registry or localStorage),
  restore on load; optional per-workspace canvas. *(2.5)*
- **Outcome:** the canvas becomes a durable, editable map of your session world.

---

## 9. Recommended v1 scope

Ship **P0 + P1** as v1:

1. Discovery reads `branchOf` / `branchNote` (additive, zero-cost).
2. `core/graph` derives `GraphModel` from existing discovery + `annotateOpen` — no new disk
   reads for visualization.
3. New endpoints: `GET /api/graph`, `POST /api/sessions/:id/fork`, `POST /api/sessions/new`,
   all routed through `SessionManager` and reusing `resume`.
4. **Fork = TS-native (`core/branch`)** with an opt-in Python-script fallback. This is the one
   place we write to `~/.copilot` — strictly creating a new `<newId>/` dir, never mutating an
   existing session — and it is gated by fixture + dry-run-resume tests.
5. A **Graph tab** (`@xyflow/react` + `@dagrejs/dagre`) that defaults to the `open`/`live`
   slice, renders fork (solid) and terminal (dashed) edges with a legend, and supports
   per-node **Resume / Fork / Recolor** plus a toolbar **+ New session**. Repo edges, drag-to-link,
   and saved layouts are explicitly **out** of v1 (P2).

Defer to later: the `all`-graph at scale (keep it filtered/capped), saved canvas layouts, and
drag-to-link gestures. This keeps v1 honest about performance and about the read-mostly
posture, while delivering the headline value: **see, fork, and resume your sessions on a
canvas.**
