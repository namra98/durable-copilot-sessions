import { useEffect, useMemo, useState } from "react";
import type { AppConfig, ColorStrategy } from "../../core/types";
import * as api from "../api/client";
import type { PushOptions, ToastKind } from "./Toast";

type PushFn = (kind: ToastKind, text: string, options?: PushOptions) => number;

interface SettingsViewProps {
  push: PushFn;
  /** Called with the saved config so the App can refresh header/state. */
  onSaved: (config: AppConfig) => void;
}

const COLOR_STRATEGIES: ColorStrategy[] = ["by-repo", "by-cwd", "rotate", "fixed"];
const WINDOW_GROUPINGS: AppConfig["windowGrouping"][] = ["by-repo", "by-cwd", "single"];
const RESTORE_OPTIONS: AppConfig["restoreOnLogin"][] = ["off", "prompt", "auto"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the human-readable launch command preview for a sample session id. */
export function launchPreview(command: string, args: string[], sampleId = "<id>"): string {
  return [command, ...args, "--resume", sampleId].filter(Boolean).join(" ");
}

/** Settings tab: load, edit, and persist {@link AppConfig}; surface stale cleanup. */
export function SettingsView({ push, onSaved }: SettingsViewProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [argsText, setArgsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setArgsText((c.copilotArgs ?? []).join("\n"));
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setConfig((curr) => (curr ? { ...curr, [key]: value } : curr));
  }

  const copilotArgs = useMemo(
    () => argsText.split("\n").map((s) => s.trim()).filter(Boolean),
    [argsText],
  );

  const preview = config ? launchPreview(config.copilotCommand, copilotArgs) : "";

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      const patch: Partial<AppConfig> = {
        apiPort: config.apiPort,
        webPort: config.webPort,
        snapshotIntervalMinutes: config.snapshotIntervalMinutes,
        maxAutoSnapshots: config.maxAutoSnapshots,
        colorStrategy: config.colorStrategy,
        autoOpenBrowser: config.autoOpenBrowser,
        windowGrouping: config.windowGrouping,
        copilotCommand: config.copilotCommand,
        copilotArgs,
        restoreOnLogin: config.restoreOnLogin,
      };
      const saved = await api.putConfig(patch);
      setConfig(saved);
      setArgsText((saved.copilotArgs ?? []).join("\n"));
      onSaved(saved);
      push("success", "Settings saved.");
    } catch (err) {
      push("error", `Save failed: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="panel">
        <div className="panel__head"><h2>Settings</h2></div>
        <p className="empty__sub">Loading configuration…</p>
      </section>
    );
  }

  if (error || !config) {
    return (
      <section className="panel">
        <div className="panel__head"><h2>Settings</h2></div>
        <div className="banner banner--error" role="alert">
          <span>{error ?? "Configuration unavailable."}</span>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="panel settings">
        <div className="panel__head">
          <h2>Settings</h2>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            Save settings
          </button>
        </div>

        <div className="settings__grid">
          <label className="field field--block">
            <span className="field__label">API port</span>
            <input
              className="input"
              type="number"
              value={config.apiPort}
              onChange={(e) => update("apiPort", Number(e.target.value))}
            />
          </label>
          <label className="field field--block">
            <span className="field__label">Web port</span>
            <input
              className="input"
              type="number"
              value={config.webPort}
              onChange={(e) => update("webPort", Number(e.target.value))}
            />
          </label>
          <label className="field field--block">
            <span className="field__label">Snapshot interval (minutes)</span>
            <input
              className="input"
              type="number"
              min={1}
              value={config.snapshotIntervalMinutes}
              onChange={(e) => update("snapshotIntervalMinutes", Number(e.target.value))}
            />
          </label>
          <label className="field field--block">
            <span className="field__label">Max auto-snapshots</span>
            <input
              className="input"
              type="number"
              min={1}
              value={config.maxAutoSnapshots}
              onChange={(e) => update("maxAutoSnapshots", Number(e.target.value))}
            />
          </label>
          <label className="field field--block">
            <span className="field__label">Color strategy</span>
            <select
              className="select"
              value={config.colorStrategy}
              onChange={(e) => update("colorStrategy", e.target.value as ColorStrategy)}
            >
              {COLOR_STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field field--block">
            <span className="field__label">Window grouping</span>
            <select
              className="select"
              value={config.windowGrouping}
              onChange={(e) => update("windowGrouping", e.target.value as AppConfig["windowGrouping"])}
            >
              {WINDOW_GROUPINGS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field field--block">
            <span className="field__label">Restore on login</span>
            <select
              className="select"
              value={config.restoreOnLogin}
              onChange={(e) => update("restoreOnLogin", e.target.value as AppConfig["restoreOnLogin"])}
            >
              {RESTORE_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field field--block">
            <span className="field__label">Copilot command</span>
            <input
              className="input"
              type="text"
              value={config.copilotCommand}
              placeholder="copilot"
              onChange={(e) => update("copilotCommand", e.target.value)}
            />
          </label>
        </div>

        <label className="field field--block">
          <span className="field__label">Copilot args (one per line)</span>
          <textarea
            className="input settings__args"
            rows={4}
            value={argsText}
            placeholder={"--mcp\nworkiq\n--yolo"}
            onChange={(e) => setArgsText(e.target.value)}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={config.autoOpenBrowser}
            onChange={(e) => update("autoOpenBrowser", e.target.checked)}
          />
          Open the browser automatically on `dcs ui`
        </label>

        <div className="settings__preview">
          <span className="field__label">Launch command preview</span>
          <code className="settings__preview-cmd">{preview}</code>
        </div>
      </section>

      <MaintenancePanel push={push} />
    </>
  );
}

interface MaintenancePanelProps {
  push: PushFn;
}

/** Stale dead-PID lock surfacing with a guarded "clean" action. */
export function MaintenancePanel({ push }: MaintenancePanelProps) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api
      .getStale()
      .then((sessions) => setCount(sessions.length))
      .catch(() => setCount(null));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function clean() {
    if (!window.confirm("Remove dead-PID lock files for stale sessions?")) return;
    setBusy(true);
    try {
      const result = await api.cleanStale(true);
      push("success", `Cleaned ${result.removed} of ${result.stale} stale lock${result.stale === 1 ? "" : "s"}.`);
      refresh();
    } catch (err) {
      push("error", `Clean failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel maintenance">
      <div className="panel__head">
        <h2>Maintenance</h2>
      </div>
      <div className="maintenance__row">
        <span>
          {count === null
            ? "Stale-session status unavailable."
            : count === 0
              ? "No stale sessions — all lock PIDs are alive."
              : `${count} stale session${count === 1 ? "" : "s"} with dead-PID locks.`}
        </span>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => void clean()}
          disabled={busy || count === null || count === 0}
        >
          Clean dead-PID locks
        </button>
      </div>
    </section>
  );
}
