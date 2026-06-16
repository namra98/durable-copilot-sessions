# Workflow Context

- **Work ID**: dcs-001
- **Title**: Durable Copilot Sessions — save/snapshot/restore Windows Terminal + Copilot CLI sessions
- **Workflow**: PAW Lite
- **Workflow Mode**: custom
- **Review Strategy**: local
- **Review Policy**: final-pr-only
- **Final Review Mode**: multi-model
- **Implementation Model**: claude-opus-4.8
- **Artifact Lifecycle**: commit-and-clean
- **Repository**: namra98/durable-copilot-sessions (private, personal account)
- **Base branch**: main
- **Feature branch**: feat/initial-implementation

## Key environment facts

- Windows 11, Windows Terminal (`wt.exe`), PowerShell 5.1 + pwsh, Node 24, dotnet 10, Python 3.10.
- `gh` is authed as naprajap_microsoft; **git.exe** push credential is the personal account **namra98** (Git Credential Manager).
- Copilot session state: `~/.copilot/session-state/<id>/workspace.yaml` (name, cwd, git_root, repository, branch) + `~/.copilot/session-store.db` `sessions` table + `inuse.<pid>.lock` liveness.
- Resume: `copilot --resume=<id>` launched from the session's recorded cwd (resume picker is cwd-scoped).
- Relaunch tab: `wt.exe new-tab --title --tabColor -d <cwd> <shell> -NoExit -File <script>` running `copilot --resume`.

## Stack (mirrors the streamliner repo the user referenced)

TypeScript (ESM, NodeNext) + Express local API + Vite + React web UI + Vitest. Zero native deps
(discovery scans workspace.yaml; optional built-in node:sqlite enrichment). Conventions: tests live
beside source as `*.test.ts`, no constructor parameter properties (erasableSyntaxOnly).
