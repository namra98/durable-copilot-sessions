# Scheduled Tasks

`dcs install-tasks` registers Windows automation so your Copilot session layout
survives reboots. `dcs uninstall-tasks` removes it. Scheduled Tasks are created
at the `LIMITED` run level (no elevation) and run as the current user. The logon
task is scoped to the current Windows user. If Windows still denies the logon
trigger, `dcs` falls back to the current user's Windows Startup known folder for
the restore prompt instead of requiring admin rights.

| Task name                            | Trigger              | Runs                          |
| ------------------------------------ | -------------------- | ----------------------------- |
| `DurableCopilotSessions-Snapshot`    | Every _N_ minutes    | `<dcs> snapshot`              |
| `DurableCopilotSessions-LogonRestore`| At user logon        | `<dcs> restore-prompt`        |
| `DurableCopilotSessions-LogonRestore.vbs` | User Startup fallback | `<dcs> restore-prompt` |

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

A non-zero exit code means the task is not registered. `dcs tasks-status` reports
the logon Scheduled Task and Startup fallback separately; if the task is missing
but the fallback is installed, Windows denied the ONLOGON Scheduled Task and
`dcs` installed the current-user Startup-folder fallback instead. The install
output includes the exact fallback path. A later successful `dcs install-tasks`
removes that fallback so the restore prompt is not shown twice.

## Task Scheduler GUI

Open **Task Scheduler** (`taskschd.msc`). The two tasks appear in the top-level
**Task Scheduler Library** node (not under a subfolder), listed by the names
above. Select one to see its **Triggers** (At log on / minute interval) and
**Actions** (the program + arguments shown in the table). You can run, disable,
or delete a task from there; deleting via the GUI is equivalent to
`dcs uninstall-tasks`. If the logon restore prompt used the Startup fallback,
you'll find `DurableCopilotSessions-LogonRestore.vbs` in the current user's
Windows Startup known folder, typically
`%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`.
