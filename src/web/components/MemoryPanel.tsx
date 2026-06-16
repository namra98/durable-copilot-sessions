import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Memory,
  MemoryKind,
  MemoryRecallPack,
  MemorySearchHit,
  WindowTarget,
} from "../../core/types";
import * as api from "../api/client";
import { buildContextPack, isRecallEmpty } from "../lib/contextPack";
import { relativeTime } from "../lib/format";

const SEARCH_DEBOUNCE_MS = 250;

const KINDS: MemoryKind[] = ["decision", "todo", "learning", "summary", "file_context"];

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Decision",
  todo: "Todo",
  learning: "Learning",
  summary: "Summary",
  file_context: "File",
};

/** Seed used to deep-link into the "Related memories" view from elsewhere. */
export interface RelatedSeed {
  sessionId: string;
  label: string;
}

interface MemoryPanelProps {
  windowTarget: WindowTarget;
  push: (kind: "success" | "error" | "info", text: string) => void;
  /** When set (and changed), load and show memories related to this session. */
  relatedSeed: RelatedSeed | null;
  onClearRelated: () => void;
}

type Mode = "search" | "recall";

/** First-class Memory/Recall view: search, repo recall pack, related, reindex. */
export function MemoryPanel({ windowTarget, push, relatedSeed, onClearRelated }: MemoryPanelProps) {
  const [mode, setMode] = useState<Mode>("search");

  // Search state.
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [repository, setRepository] = useState("");
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Recall state.
  const [recallRepo, setRecallRepo] = useState("");
  const [recallBranch, setRecallBranch] = useState("");
  const [recallSubmitted, setRecallSubmitted] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [pack, setPack] = useState<MemoryRecallPack | null>(null);

  // Related state.
  const [related, setRelated] = useState<Memory[] | null>(null);
  const [relatedError, setRelatedError] = useState<string | null>(null);

  const [reindexing, setReindexing] = useState(false);

  // Debounce the search box.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [queryInput]);

  // Run a search whenever the debounced query or filters change. An empty
  // query loads the most recent memories so the panel is never blank.
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    api
      .searchMemory({
        q: query.trim(),
        kind: kind || undefined,
        repository: repository.trim() || undefined,
        limit: 50,
      })
      .then((result) => {
        if (!cancelled) setHits(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setSearchError(err instanceof Error ? err.message : String(err));
          setHits([]);
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, kind, repository]);

  // React to a related-memory deep link from a graph node / session card.
  const lastSeed = useRef<string | null>(null);
  useEffect(() => {
    if (!relatedSeed) return;
    if (lastSeed.current === relatedSeed.sessionId) return;
    lastSeed.current = relatedSeed.sessionId;
    setRelatedError(null);
    setRelated(null);
    api
      .relatedMemory(relatedSeed.sessionId)
      .then(setRelated)
      .catch((err) => setRelatedError(err instanceof Error ? err.message : String(err)));
  }, [relatedSeed]);

  const resume = useCallback(
    async (sessionId: string, title?: string) => {
      try {
        const result = await api.resumeSession(sessionId, { window: windowTarget, title });
        if (result.ok) push("success", `Resumed session`);
        else push("error", `Resume failed: ${result.error ?? "unknown error"}`);
      } catch (err) {
        push("error", `Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [windowTarget, push],
  );

  const runRecall = useCallback(async () => {
    const repo = recallRepo.trim();
    if (!repo) return;
    setRecallSubmitted(true);
    setRecalling(true);
    setRecallError(null);
    try {
      const result = await api.recallMemory(repo, recallBranch.trim() || undefined);
      setPack(result);
    } catch (err) {
      setRecallError(err instanceof Error ? err.message : String(err));
      setPack(null);
    } finally {
      setRecalling(false);
    }
  }, [recallRepo, recallBranch]);

  const copyPack = useCallback(async () => {
    if (!pack) return;
    const markdown = buildContextPack(pack);
    try {
      await navigator.clipboard.writeText(markdown);
      push("success", "Context pack copied to clipboard.");
    } catch {
      push("error", "Clipboard unavailable — copy blocked by the browser.");
    }
  }, [pack, push]);

  const reindex = useCallback(async () => {
    setReindexing(true);
    try {
      const count = await api.reindexMemory();
      push("success", `Reindexed ${count} memor${count === 1 ? "y" : "ies"}.`);
    } catch (err) {
      push("error", `Reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReindexing(false);
    }
  }, [push]);

  return (
    <section className="panel mempanel">
      <div className="panel__head">
        <h2>Memory &amp; recall</h2>
        <div className="mempanel__head-actions">
          <div className="seg" role="group" aria-label="Memory mode">
            <button
              type="button"
              className={`seg__btn${mode === "search" ? " seg__btn--on" : ""}`}
              onClick={() => setMode("search")}
            >
              Search
            </button>
            <button
              type="button"
              className={`seg__btn${mode === "recall" ? " seg__btn--on" : ""}`}
              onClick={() => setMode("recall")}
            >
              Recall for repo
            </button>
          </div>
          <button type="button" className="btn" onClick={() => void reindex()} disabled={reindexing}>
            {reindexing ? "Reindexing…" : "Reindex memories"}
          </button>
        </div>
      </div>

      {relatedSeed && (
        <div className="mem-related">
          <div className="mem-related__head">
            <span className="mem-related__title">
              Related to “{relatedSeed.label}”
            </span>
            <button type="button" className="btn btn--ghost" onClick={onClearRelated}>
              Dismiss
            </button>
          </div>
          {relatedError ? (
            <p className="mem-related__error">{relatedError}</p>
          ) : related === null ? (
            <p className="mem-related__loading">Loading related memories…</p>
          ) : related.length === 0 ? (
            <p className="mem-related__empty">No related memories found.</p>
          ) : (
            <div className="memgrid">
              {related.map((m) => (
                <MemoryCard key={m.id} memory={m} onResume={resume} />
              ))}
            </div>
          )}
        </div>
      )}

      {mode === "search" ? (
        <>
          <div className="toolbar">
            <div className="toolbar__search">
              <span className="toolbar__search-icon" aria-hidden="true">⌕</span>
              <input
                className="input toolbar__search-input"
                type="search"
                value={queryInput}
                placeholder="Search decisions, todos, learnings…"
                aria-label="Search memories"
                onChange={(e) => setQueryInput(e.target.value)}
              />
            </div>

            <label className="field">
              <span className="field__label">Kind</span>
              <select
                className="select"
                value={kind}
                onChange={(e) => setKind(e.target.value as MemoryKind | "")}
              >
                <option value="">All kinds</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Repo</span>
              <input
                className="input"
                value={repository}
                placeholder="owner/repo"
                onChange={(e) => setRepository(e.target.value)}
              />
            </label>
          </div>

          {searchError ? (
            <div className="empty empty--cta">
              <p className="empty__title">Memory search unavailable</p>
              <p className="empty__sub">{searchError}</p>
            </div>
          ) : searching && hits.length === 0 ? (
            <div className="empty">
              <p className="empty__sub">Searching…</p>
            </div>
          ) : hits.length === 0 ? (
            query.trim() === "" ? (
              <div className="empty empty--cta">
                <p className="empty__title">No memories indexed yet</p>
                <p className="empty__sub">
                  Click “Reindex memories” to build your recall index from past sessions.
                </p>
              </div>
            ) : (
              <div className="empty">
                <p className="empty__sub">No memories match “{query.trim()}”.</p>
              </div>
            )
          ) : (
            <>
              {query.trim() === "" && (
                <p className="mem-recent-label">Recent memories ({hits.length})</p>
              )}
              <div className="memgrid">
                {hits.map((hit) => (
                  <MemoryCard
                    key={hit.memory.id}
                    memory={hit.memory}
                    snippet={hit.snippet}
                    score={hit.score}
                    onResume={resume}
                  />
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="toolbar">
            <label className="field field--block">
              <span className="field__label">Repository</span>
              <input
                className="input"
                value={recallRepo}
                placeholder="owner/repo"
                onChange={(e) => setRecallRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runRecall();
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">Branch</span>
              <input
                className="input"
                value={recallBranch}
                placeholder="(optional)"
                onChange={(e) => setRecallBranch(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void runRecall()}
              disabled={!recallRepo.trim() || recalling}
            >
              Recall
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void copyPack()}
              disabled={!pack || isRecallEmpty(pack)}
            >
              Copy context pack
            </button>
          </div>

          {recallError ? (
            <div className="empty empty--cta">
              <p className="empty__title">Recall unavailable</p>
              <p className="empty__sub">{recallError}</p>
            </div>
          ) : !recallSubmitted ? (
            <div className="empty">
              <p className="empty__title">Recall a repository’s context</p>
              <p className="empty__sub">
                Enter a repo to gather its decisions, open todos, and key files.
              </p>
            </div>
          ) : recalling ? (
            <div className="empty">
              <p className="empty__sub">Recalling…</p>
            </div>
          ) : pack && isRecallEmpty(pack) ? (
            <div className="empty">
              <p className="empty__sub">No memories recalled for this repository yet.</p>
            </div>
          ) : pack ? (
            <div className="recall">
              <RecallGroup title="Decisions" memories={pack.decisions} onResume={resume} />
              <RecallGroup title="Open todos" memories={pack.todos} onResume={resume} />
              <RecallGroup title="Summaries" memories={pack.summaries} onResume={resume} />
              {pack.files.length > 0 && (
                <div className="recall__group">
                  <h3 className="recall__title">
                    Key files <span className="count">{pack.files.length}</span>
                  </h3>
                  <ul className="recall__files">
                    {pack.files.map((f) => (
                      <li key={f} className="recall__file" title={f}>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

interface RecallGroupProps {
  title: string;
  memories: Memory[];
  onResume: (sessionId: string, title?: string) => void;
}

function RecallGroup({ title, memories, onResume }: RecallGroupProps) {
  if (memories.length === 0) return null;
  return (
    <div className="recall__group">
      <h3 className="recall__title">
        {title} <span className="count">{memories.length}</span>
      </h3>
      <div className="memgrid">
        {memories.map((m) => (
          <MemoryCard key={m.id} memory={m} onResume={onResume} />
        ))}
      </div>
    </div>
  );
}

interface MemoryCardProps {
  memory: Memory;
  snippet?: string;
  score?: number;
  onResume: (sessionId: string, title?: string) => void;
}

function MemoryCard({ memory, snippet, score, onResume }: MemoryCardProps) {
  const body = snippet ?? memory.content;
  return (
    <article className="memcard">
      <header className="memcard__head">
        <span className={`memchip memchip--${memory.kind}`}>{KIND_LABEL[memory.kind]}</span>
        {memory.title && <span className="memcard__title" title={memory.title}>{memory.title}</span>}
        {score !== undefined && (
          <span className="memcard__score" title="Relevance score">
            {score.toFixed(2)}
          </span>
        )}
      </header>

      <p className="memcard__body">{body}</p>

      <footer className="memcard__foot">
        {memory.repository && (
          <span className="memcard__repo" title={memory.repository}>
            {memory.repository}
          </span>
        )}
        {memory.branch && <span className="memcard__branch">⎇ {memory.branch}</span>}
        <span className="memcard__time" title={new Date(memory.updatedAt).toLocaleString()}>
          {relativeTime(new Date(memory.updatedAt).toISOString())}
        </span>
        <button
          type="button"
          className="btn btn--ghost memcard__resume"
          onClick={() => onResume(memory.sessionId, memory.title)}
        >
          ▶ Resume session
        </button>
      </footer>
    </article>
  );
}
