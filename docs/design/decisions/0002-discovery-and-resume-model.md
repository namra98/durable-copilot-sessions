# 2. Discovery and resume model

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** project authors

## Context

The tool must list Copilot CLI sessions — including ones the user never launched through the tool —
and reattach to them later. Copilot persists each session under
`~/.copilot/session-state/<id>/`, which gives us:

- a `workspace.yaml` per session with `name`, `cwd`, `git_root`, `repository`, and `branch`;
- `inuse.<pid>.lock` files that signal a process currently holds the session;
- a global `~/.copilot/session-store.db` SQLite index that can supply a human-readable summary.

Two realities shape the design:

1. **Liveness is ambiguous.** Lock files can be **stale** (the process died without cleanup), and a
   **single PID can lock several sessions** at once when subagents are involved — so "has a lock" is
   not the same as "is a live, top-level interactive session."
2. **Resume is cwd-scoped.** Copilot's `--resume` picker is scoped to a working directory. Reattaching
   reliably means launching `copilot --resume` **from the session's recorded `cwd`**, not from
   wherever the new tab happens to start.

We also want the tool to be safe: it must never corrupt or alter Copilot's own state.

## Decision

**Discovery** reads `~/.copilot` as **read-only** and produces a `DiscoveredSession` per session:

- parse `workspace.yaml` for identity and location fields;
- classify liveness as `live` (lock present, PID alive), `stale` (lock present, PID dead), or
  `inactive` (no lock);
- record alive PIDs (`livePids`) and make a **best-effort** determination of `topLevel` interactive
  sessions, which become the default selection for "save current layout";
- optionally enrich with a `summary` from `session-store.db` using built-in `node:sqlite` inside a
  try/catch, so a missing/locked/incompatible DB never breaks discovery.

**Resume** is **cwd-scoped**: every (re)launched tab `cd`s to the session's recorded `cwd` before
running `copilot --resume`. To stay robust when directories move or are deleted, restore applies a
**fallback chain**:

```
recorded cwd  →  git_root  →  home directory   (emit a warning on fallback)
```

## Consequences

**Positive**

- Sessions launched outside the tool are still discoverable and resumable.
- Liveness reflects reality (stale locks don't masquerade as live sessions), and the `topLevel`
  heuristic keeps subagent/child sessions out of the default "save" selection.
- The cwd-scoped resume matches how Copilot's picker actually works, so reattach is reliable.
- Reading-only guarantees the tool can never damage Copilot state; SQLite is a bonus, never a
  dependency.

**Negative / trade-offs**

- `topLevel` and stale-lock detection are **heuristics**; pathological PID reuse or unusual lock
  patterns can misclassify a session. They are best-effort and surfaced as status, not treated as
  ground truth.
- The cwd fallback can land a resumed session in a different directory than originally intended; this
  is made visible via a warning in the `LaunchResult` rather than failing silently.
- Relying on `workspace.yaml` and the lock-file convention couples discovery to Copilot's current
  on-disk format; if that format changes, discovery must be updated.
