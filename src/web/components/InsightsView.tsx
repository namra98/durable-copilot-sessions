import { useEffect, useMemo, useState } from "react";
import * as api from "../api/client";
import type { StatsReport } from "../api/client";
import { scaleBars, toCsv } from "../lib/insights";
import { triggerDownload } from "../lib/download";
import { absoluteTime, relativeTime } from "../lib/format";
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
      <section className="panel">
        <div className="panel__head">
          <h2>Insights</h2>
        </div>
        <p className="empty__sub">Loading stats…</p>
      </section>
    );
  }

  if (unavailable) {
    return (
      <section className="panel">
        <div className="panel__head">
          <h2>Insights</h2>
        </div>
        <div className="empty empty--cta">
          <p className="empty__title">Insights are unavailable</p>
          <p className="empty__sub">The stats endpoint returned no data on this server.</p>
        </div>
      </section>
    );
  }

  if (error || !stats) {
    return (
      <section className="panel">
        <div className="panel__head">
          <h2>Insights</h2>
          <button type="button" className="btn btn--ghost" onClick={load}>
            Retry
          </button>
        </div>
        <div className="banner banner--error" role="alert">
          <span>{error ?? "No stats available."}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel insights">
      <div className="panel__head">
        <h2>Insights</h2>
        <span className="insights__generated" title={absoluteTime(stats.generatedAt)}>
          generated {relativeTime(stats.generatedAt)}
        </span>
        <button type="button" className="btn btn--ghost" onClick={exportCsv}>
          Export activity CSV
        </button>
        <button type="button" className="btn btn--ghost" onClick={load}>
          Refresh
        </button>
      </div>

      <div className="insights__totals">
        <StatCard label="Sessions" value={stats.totalSessions} />
        <StatCard label="Checkpoints" value={stats.totalCheckpoints} />
        <StatCard label="Turns" value={stats.totalTurns} />
      </div>

      <div className="insights__grid">
        <div className="insights__card">
          <h3 className="insights__card-title">Top repositories</h3>
          {stats.topRepos.length === 0 ? (
            <p className="empty__sub">No repository activity recorded.</p>
          ) : (
            <ul className="repobars">
              {stats.topRepos.map((r) => {
                const pct = maxRepoSessions > 0 ? (r.sessions / maxRepoSessions) * 100 : 0;
                return (
                  <li className="repobar" key={r.repository}>
                    <span className="repobar__name" title={r.repository}>
                      {r.repository}
                    </span>
                    <span className="repobar__track">
                      <span className="repobar__fill" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="repobar__count">{formatNumber(r.sessions)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="insights__card">
          <h3 className="insights__card-title">Activity · last {activity.length} days</h3>
          {activity.length === 0 ? (
            <p className="empty__sub">No recent activity.</p>
          ) : (
            <div className="actchart" style={{ height: CHART_HEIGHT }} role="img" aria-label="Daily session activity">
              {activity.map((a, i) => (
                <span
                  key={a.date}
                  className="actchart__bar"
                  style={{ height: bars[i] }}
                  title={`${a.date}: ${a.sessions} session${a.sessions === 1 ? "" : "s"}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface StatCardProps {
  label: string;
  value: number;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="statcard">
      <span className="statcard__value">{formatNumber(value)}</span>
      <span className="statcard__label">{label}</span>
    </div>
  );
}
