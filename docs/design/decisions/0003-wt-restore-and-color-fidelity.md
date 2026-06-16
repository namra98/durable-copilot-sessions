# 3. Windows Terminal restore and color fidelity

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** project authors

## Context

The core promise is to restore the user's layout **exactly**: the same windows, the same tabs, with
the same **titles**, **colors**, and **window grouping** they had before a reboot.

The blocker is Windows Terminal itself. `wt.exe` can **create** tabs with a given title, color
(`--tabColor`), starting directory (`-d`), and window target — but Windows Terminal exposes **no API
to read a live tab's** current color, title, or which window it belongs to. There is no way to
"scrape" the running layout. So at snapshot time we cannot simply ask Windows Terminal what the user
is looking at.

This means perfect fidelity is only achievable for state the tool itself knows about — i.e. metadata
captured when the user launches or customizes a session **through** the tool.

## Decision

Split fidelity into two tiers and be explicit about both.

1. **Managed sessions (full fidelity).** When a session is launched or customized through the tool
   (`dcs new`, `dcs resume`, or editing title/color in the dashboard), persist a `ManagedSession`
   record (`title`, `color`, `group`, `pinned`, `hidden`). On restore, these are reproduced exactly.

2. **Auto-discovered sessions (approximate fidelity).** Sessions the tool never touched are restored
   from `workspace.yaml` data:
   - **name + cwd** come straight from discovery;
   - **color** is **auto-assigned** via a stable hash → fixed palette mapping (the same key always
     maps to the same color), per the configured `colorStrategy`;
   - **window grouping** defaults to **by repository** (`windowGrouping: "by-repo"`), which matches the
     user's habit of one color/window per repo. `by-cwd` and `single` are also available.

Explicitly saved workspaces (`dcs save`) preserve their **exact** captured grouping; auto-snapshots of
discovered-only sessions use the heuristic grouping above.

## Consequences

**Positive**

- Users get pixel-faithful restores for everything they manage through the tool, and a sensible,
  deterministic approximation for everything else — colors are stable across restores rather than
  random.
- Repository-based grouping reconstructs the user's "one window per repo" mental model without any
  manual setup.
- No fragile dependency on undocumented Windows Terminal internals or screen-scraping.

**Negative / trade-offs**

- The **exact** original colors/titles of manually-created tabs that predate tool adoption **cannot be
  recovered** — this is a hard limitation of Windows Terminal, documented honestly in the README.
- Fidelity improves over time as the user routes more launches through the tool, which is a behavioral
  ask rather than something the tool can guarantee on day one.
- If Windows Terminal ever ships a live-layout introspection API, this decision should be revisited —
  much of the heuristic tier could then be replaced by real capture.
