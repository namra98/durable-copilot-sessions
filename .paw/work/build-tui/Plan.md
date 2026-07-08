# Plan: Build TUI

## Approach summary

Add a terminal dashboard as the second interactive surface beside the existing web dashboard. The TUI should reuse `SessionManager`, avoid native dependencies, and expose the core workflows a terminal user needs: browse sessions, search/filter, resume, snapshot/save/restore layouts, refresh, and quit.

## Work items

1. **TUI view model helpers**
   - Add pure helper functions for formatting session/workspace rows, status labels, truncation, filtering, and key help.
   - Keep these helpers independent of terminal state so Vitest can cover them.

2. **Interactive terminal runtime**
   - Implement a raw-mode terminal loop with ANSI rendering and keyboard shortcuts.
   - Provide sessions and workspaces panes, navigation, filter cycling, search input, refresh, resume, workspace save/restore, snapshot, and quit.
   - Keep all operations routed through `SessionManager`.

3. **CLI, docs, and tests**
   - Wire the runtime as `dcs tui`.
   - Document the TUI in README and design docs as the terminal alternative to `dcs ui`.
   - Add unit tests for view model behavior.

## Key decisions

- Use only Node built-ins for terminal rendering to preserve the project's zero-native-dependency constraint.
- Prefer a compact keyboard-driven interface over attempting to embed the web dashboard.
- Keep launch actions explicit and visible with status messages because restore/resume can open Windows Terminal tabs.
