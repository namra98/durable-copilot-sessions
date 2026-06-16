# Scheduled Tasks

`dcs install-tasks` registers two Windows Scheduled Tasks so your Copilot session
layout survives reboots. `dcs uninstall-tasks` removes them. Both are created at
the `LIMITED` run level (no elevation) and run as the current user.

| Task name                            | Trigger              | Runs                          |
| ------------------------------------ | -------------------- | ----------------------------- |
| `DurableCopilotSessions-Snapshot`    | Every _N_ minutes    | `<dcs> snapshot`              |
| `DurableCopilotSessions-LogonRestore`| At user logon        | `<dcs> restore-prompt`        |

`<dcs>` is the fully-resolved command line the CLI passes in — e.g.
`node <repoRoot>\dist\cli\index.js` (built) or `npx tsx <repoRoot>\src\cli\index.ts`
(dev). The snapshot interval comes from `snapshotIntervalMinutes` in the config.

## Inspecting the tasks

From a terminal:

```powershell
schtasks /Query /TN DurableCopilotSessions-Snapshot
schtasks /Query /TN DurableCopilotSessions-LogonRestore
schtasks /Query /TN DurableCopilotSessions-Snapshot /V /FO LIST   # full detail
```

A non-zero exit code means the task is not registered.

## Task Scheduler GUI

Open **Task Scheduler** (`taskschd.msc`). The two tasks appear in the top-level
**Task Scheduler Library** node (not under a subfolder), listed by the names
above. Select one to see its **Triggers** (At log on / minute interval) and
**Actions** (the program + arguments shown in the table). You can run, disable,
or delete a task from there; deleting via the GUI is equivalent to
`dcs uninstall-tasks`.
