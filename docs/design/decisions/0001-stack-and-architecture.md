# 1. Stack and architecture

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** project authors

## Context

Durable Copilot Sessions must:

- run reliably on **Windows 11** and drive **Windows Terminal** (`wt.exe`);
- keep durable state on disk that survives reboots and forced updates;
- offer both a **scriptable CLI** and a **visual dashboard** for one-click resume/restore;
- be easy to maintain as a personal/portfolio project with a small surface area.

A previous instinct was to build this entirely in **PowerShell**, since the tool is Windows-centric
and PowerShell talks to `wt.exe` and Scheduled Tasks natively. In practice that path was rejected: a
PowerShell-only tool is awkward to structure into testable units, has no natural story for a web
dashboard, and is harder to evolve into a durable, well-typed state model. It is "scripting" where we
want a small, maintainable application.

The user already maintains a TypeScript "streamliner" repo with the same shape (TypeScript + Express +
Vite + React + Vitest). Mirroring that stack maximizes familiarity and code/convention reuse.

## Decision

Build the tool as a single **TypeScript (ESM, `NodeNext`)** codebase with:

- a shared **core** (types, paths, config, discovery, registry, launch, snapshot);
- an **Express** local API server (default port `4517`) as the single integration point;
- a **Vite + React** web dashboard that talks to that API (dev port `4516`, proxies `/api`);
- a **`dcs` CLI** that calls the same core/server functionality;
- **Vitest** for tests that live beside source.

Adopt a **zero native dependency** rule. Discovery reads Copilot's `workspace.yaml` (plain text);
optional SQLite enrichment uses Node's **built-in `node:sqlite`** behind a try/catch so the tool never
fails to install or run because of a native module. Required runtime deps are limited to small,
pure-JS packages (`commander`, `express`, `open`, `react`, `react-dom`, `yaml`).

## Consequences

**Positive**

- One language and one mental model across CLI, server, and web; the core is unit-testable in
  isolation.
- A real web dashboard becomes natural, not bolted on.
- Zero native deps means `npm install` is fast and portable, with no toolchain surprises across Node
  versions; the tool degrades gracefully where `node:sqlite` is unavailable.
- The architecture mirrors the user's existing repo, reducing cognitive load and easing reuse.

**Negative / trade-offs**

- Requires **Node ≥ 20** on the machine (acceptable; the user already runs Node 24).
- Talking to `wt.exe` and Scheduled Tasks from Node means shelling out, which is slightly more
  ceremony than native PowerShell cmdlets — mitigated by isolating those calls behind the `launch` and
  `scheduling` modules with pure, dry-run-testable argv builders.
- The tool remains **Windows-only** regardless of language, because `wt.exe` is the integration
  surface.
