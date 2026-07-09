import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Save, Trash2, Wrench } from "lucide-react";
import type { AppConfig, ColorStrategy } from "../lib/apiTypes";
import * as api from "../lib/apiClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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
      <section className="space-y-6">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </section>
    );
  }

  if (error || !config) {
    return (
      <section className="space-y-6">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error ?? "Configuration unavailable."}</span>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Settings</h2>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            <Save className="size-4" />
            Save settings
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Server</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="apiPort">API port</Label>
                <Input
                  id="apiPort"
                  type="number"
                  value={config.apiPort}
                  onChange={(e) => update("apiPort", Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="webPort">Web port</Label>
                <Input
                  id="webPort"
                  type="number"
                  value={config.webPort}
                  onChange={(e) => update("webPort", Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="snapshotInterval">Snapshot interval (minutes)</Label>
                <Input
                  id="snapshotInterval"
                  type="number"
                  min={1}
                  value={config.snapshotIntervalMinutes}
                  onChange={(e) =>
                    update("snapshotIntervalMinutes", Number(e.target.value))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxAutoSnapshots">Max auto-snapshots</Label>
                <Input
                  id="maxAutoSnapshots"
                  type="number"
                  min={1}
                  value={config.maxAutoSnapshots}
                  onChange={(e) => update("maxAutoSnapshots", Number(e.target.value))}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance &amp; behavior</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="colorStrategy">Color strategy</Label>
                <Select
                  value={config.colorStrategy}
                  onValueChange={(v) => update("colorStrategy", v as ColorStrategy)}
                >
                  <SelectTrigger id="colorStrategy" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLOR_STRATEGIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="windowGrouping">Window grouping</Label>
                <Select
                  value={config.windowGrouping}
                  onValueChange={(v) =>
                    update("windowGrouping", v as AppConfig["windowGrouping"])
                  }
                >
                  <SelectTrigger id="windowGrouping" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WINDOW_GROUPINGS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="restoreOnLogin">Restore on login</Label>
                <Select
                  value={config.restoreOnLogin}
                  onValueChange={(v) =>
                    update("restoreOnLogin", v as AppConfig["restoreOnLogin"])
                  }
                >
                  <SelectTrigger id="restoreOnLogin" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESTORE_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator />

            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-4">
              <div className="space-y-1">
                <Label htmlFor="autoOpenBrowser">Auto-open browser</Label>
                <p className="text-xs text-muted-foreground">
                  Open the browser automatically on{" "}
                  <span className="font-mono">dcs ui</span>.
                </p>
              </div>
              <Switch
                id="autoOpenBrowser"
                checked={config.autoOpenBrowser}
                onCheckedChange={(checked) => update("autoOpenBrowser", checked)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Copilot launch</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="copilotCommand">Copilot command</Label>
              <Input
                id="copilotCommand"
                type="text"
                value={config.copilotCommand}
                placeholder="copilot"
                onChange={(e) => update("copilotCommand", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="copilotArgs">Copilot args (one per line)</Label>
              <textarea
                id="copilotArgs"
                rows={4}
                value={argsText}
                placeholder={"--mcp\nworkiq\n--yolo"}
                onChange={(e) => setArgsText(e.target.value)}
                className={cn(
                  "flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none",
                  "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>Launch command preview</Label>
              <code className="block break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                {preview}
              </code>
            </div>
          </CardContent>
        </Card>
      </section>

      <MaintenancePanel push={push} />
    </div>
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
      const result = await api.cleanStale(true, true);
      push("success", `Cleaned ${result.removed} of ${result.stale} stale lock${result.stale === 1 ? "" : "s"}.`);
      refresh();
    } catch (err) {
      push("error", `Clean failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">Maintenance</h2>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" />
            Stale sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {count === null
                ? "Stale-session status unavailable."
                : count === 0
                  ? "No stale sessions — all lock PIDs are alive."
                  : `${count} stale session${count === 1 ? "" : "s"} with dead-PID locks.`}
            </span>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void clean()}
              disabled={busy || count === null || count === 0}
            >
              <Trash2 className="size-4" />
              Clean dead-PID locks
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
