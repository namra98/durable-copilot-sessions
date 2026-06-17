import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Database,
  Download,
  FolderGit2,
  type LucideIcon,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import * as api from "../api/client";
import type { StatsReport } from "../api/client";
import { scaleBars, toCsv } from "../lib/insights";
import { triggerDownload } from "../lib/download";
import { absoluteTime, relativeTime } from "../lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PushOptions, ToastKind } from "./Toast";

type PushFn = (kind: ToastKind, text: string, options?: PushOptions) => number;

interface InsightsViewProps {
  push: PushFn;
}

const CHART_HEIGHT = 120;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Read-only analytics over the Copilot session store: totals, top repos, activity. */
export function InsightsView({ push }: InsightsViewProps) {
  const [stats, setStats] = useState<StatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useMemo(
    () => () => {
      setLoading(true);
      setError(null);
      api
        .getStats()
        .then((s) => {
          setStats(s);
          setUnavailable(false);
        })
        .catch((err) => {
          const msg = errorMessage(err);
          if (/(404|not found)/i.test(msg)) setUnavailable(true);
          else setError(msg);
        })
        .finally(() => setLoading(false));
    },
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const activity = stats?.activityByDay ?? [];
  const bars = useMemo(
    () => scaleBars(activity.map((a) => a.sessions), CHART_HEIGHT),
    [activity],
  );
  const maxRepoSessions = useMemo(
    () => (stats ? stats.topRepos.reduce((m, r) => Math.max(m, r.sessions), 0) : 0),
    [stats],
  );

  function exportCsv() {
    if (!stats) return;
    const csv = toCsv(
      stats.activityByDay.map((a) => ({ date: a.date, sessions: a.sessions })),
      ["date", "sessions"],
    );
    triggerDownload("activity-by-day.csv", csv, "text/csv");
    push("success", "Exported activity CSV.");
  }

  if (loading) {
    return (
      <section className="space-y-6">
        <h2 className="text-lg font-semibold">Insights</h2>
        <p className="text-sm text-muted-foreground">Loading stats…</p>
      </section>
    );
  }

  if (unavailable) {
    return (
      <section className="space-y-6">
        <h2 className="text-lg font-semibold">Insights</h2>
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Database className="size-6 text-muted-foreground" />
            <p className="font-semibold">Insights are unavailable</p>
            <p className="text-sm text-muted-foreground">
              The stats endpoint returned no data on this server.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (error || !stats) {
    return (
      <section className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Insights</h2>
          <Button type="button" variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </div>
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error ?? "No stats available."}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Insights</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground">
                generated {relativeTime(stats.generatedAt)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{absoluteTime(stats.generatedAt)}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
            <Download className="size-4" />
            Export activity CSV
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Sessions" value={stats.totalSessions} icon={Activity} />
        <StatCard label="Checkpoints" value={stats.totalCheckpoints} icon={Database} />
        <StatCard label="Turns" value={stats.totalTurns} icon={TrendingUp} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderGit2 className="size-4 text-muted-foreground" />
              Top repositories
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats.topRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repository activity recorded.
              </p>
            ) : (
              <ul className="space-y-3">
                {stats.topRepos.map((r) => {
                  const pct =
                    maxRepoSessions > 0 ? (r.sessions / maxRepoSessions) * 100 : 0;
                  return (
                    <li
                      key={r.repository}
                      className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5"
                    >
                      <span
                        className="truncate font-mono text-xs text-foreground"
                        title={r.repository}
                      >
                        {r.repository}
                      </span>
                      <Badge variant="secondary" className="tabular-nums">
                        {formatNumber(r.sessions)}
                      </Badge>
                      <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="size-4 text-muted-foreground" />
              Activity · last {activity.length} days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity.</p>
            ) : (
              <div
                className="flex items-end gap-1"
                style={{ height: CHART_HEIGHT }}
                role="img"
                aria-label="Daily session activity"
              >
                {activity.map((a, i) => (
                  <Tooltip key={a.date}>
                    <TooltipTrigger asChild>
                      <span
                        className="min-h-px flex-1 rounded-sm bg-primary/80 transition-colors hover:bg-primary"
                        style={{ height: bars[i] }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      {a.date}: {a.sessions} session{a.sessions === 1 ? "" : "s"}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

interface StatCardProps {
  label: string;
  value: number;
  icon: LucideIcon;
}

function StatCard({ label, value, icon: Icon }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {formatNumber(value)}
          </span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-md",
            "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-5" />
        </span>
      </CardContent>
    </Card>
  );
}
