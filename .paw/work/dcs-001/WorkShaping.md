# Work Shaping — Durable Copilot Sessions

## Problem

The user runs dozens of Copilot CLI sessions across Windows Terminal tabs, each named and color-coded
to track parallel work. Windows force-restarts for updates and destroys the entire live layout —
every named/colored tab and its in-flight Copilot session is lost, which loses work and context.
Copilot session state itself survives on disk (`~/.copilot/session-state`), but Windows Terminal's
tab layout (titles, colors, window grouping) and the tab→session mapping are volatile and gone.

## Goal

A durable tool that saves the session layout and re-opens the exact Windows Terminal windows + tabs
with each Copilot session resumed — surviving reboots.

## Decisions (confirmed with user)

- **Repo**: `namra98/durable-copilot-sessions` (private, personal account). Push via git.exe (namra98).
- **Stack**: best-in-class / robust — TypeScript + Express + Vite + React + Vitest, mirroring the
  streamliner repo. (PowerShell rejected as not durable enough.)
- **UI**: a web dashboard listing active/known sessions with **one-click resume** that opens a
  Windows Terminal tab via `wt.exe`.
- **Auto-discover** sessions not launched through the tool: yes (scan `~/.copilot/session-state`).
- **Snapshot mode**: periodic background auto-snapshot + restore prompt on login.

## Critical technical findings

- Per-session `workspace.yaml` yields name, cwd, git_root, repository, branch — enough to rebuild a
  tab except color/window-grouping (WT exposes no API to read a live tab's color/title/window).
- Therefore **full-fidelity restore requires the tool to record** color/title/grouping (managed
  metadata) going forward; autodiscovered sessions get name+cwd and an auto-assigned color, grouped
  by repository by default. This is an honest, documented limitation.
- Resume is **cwd-scoped**: every relaunched tab must `cd` to the session's recorded cwd before
  `copilot --resume=<id>`. Restore must handle a missing cwd (fall back to git_root, then home, warn).
- Many `inuse.<pid>.lock` files exist; some are stale and some PIDs lock multiple sessions
  (subagents). Discovery must check PID liveness and best-effort flag top-level interactive sessions.

## Out of scope

- Cross-platform (Windows-only by nature of `wt.exe`).
- Reconstructing colors/titles of manually-created tabs that predate tool adoption (impossible).
- Capturing/replaying Copilot conversation content (Copilot already persists it; we only resume).
