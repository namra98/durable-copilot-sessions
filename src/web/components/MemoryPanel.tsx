import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrainCircuit,
  Clock,
  Copy,
  File,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GraduationCap,
  ListTodo,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  Memory,
  MemoryKind,
  MemoryRecallPack,
  MemorySearchHit,
  WindowTarget,
} from "../../core/types";
import * as api from "../lib/apiClient";
import { buildContextPack, isRecallEmpty } from "../lib/contextPack";
import { relativeTime } from "../lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SEARCH_DEBOUNCE_MS = 250;

const KINDS: MemoryKind[] = ["chat", "decision", "todo", "learning", "summary", "file_context"];

const KIND_LABEL: Record<MemoryKind, string> = {
  chat: "Chat",
  decision: "Decision",
  todo: "Todo",
  learning: "Learning",
  summary: "Summary",
  file_context: "File",
};

const KIND_ICON: Record<MemoryKind, LucideIcon> = {
  chat: MessageSquare,
  decision: GitCommitHorizontal,
  todo: ListTodo,
  learning: GraduationCap,
  summary: FileText,
  file_context: File,
};

/** Sentinel used by the kind <Select> to represent the empty "all kinds" value. */
const ALL_KINDS = "__all__";

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
    <section className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Memory &amp; recall</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
            role="group"
            aria-label="Memory mode"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={mode === "search"}
              className={cn(
                "h-7",
                mode === "search"
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground",
              )}
              onClick={() => setMode("search")}
            >
              <Search className="size-4" />
              Search
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={mode === "recall"}
              className={cn(
                "h-7",
                mode === "recall"
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground",
              )}
              onClick={() => setMode("recall")}
            >
              <BrainCircuit className="size-4" />
              Recall for repo
            </Button>
          </div>
          <Button type="button" variant="outline" onClick={() => void reindex()} disabled={reindexing}>
            <RefreshCw className={cn("size-4", reindexing && "animate-spin")} />
            {reindexing ? "Reindexing…" : "Reindex memories"}
          </Button>
        </div>
      </div>

      {relatedSeed && (
        <Card className="gap-3 border-border py-3">
          <div className="flex items-center justify-between gap-2 px-4">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4 text-primary" />
              Related to “{relatedSeed.label}”
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={onClearRelated}>
              <X className="size-4" />
              Dismiss
            </Button>
          </div>
          <div className="px-4">
            {relatedError ? (
              <p className="text-sm text-destructive">{relatedError}</p>
            ) : related === null ? (
              <p className="text-sm text-muted-foreground">Loading related memories…</p>
            ) : related.length === 0 ? (
              <p className="text-sm text-muted-foreground">No related memories found.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {related.map((m) => (
                  <MemoryCard key={m.id} memory={m} onResume={resume} />
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {mode === "search" ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[16rem] flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={queryInput}
                placeholder="Search anything you discussed, or paste a session id…"
                aria-label="Search memories"
                className="pl-9"
                onChange={(e) => setQueryInput(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Kind</span>
              <Select
                value={kind || ALL_KINDS}
                onValueChange={(v) => setKind(v === ALL_KINDS ? "" : (v as MemoryKind))}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="All kinds" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_KINDS}>All kinds</SelectItem>
                  {KINDS.map((k) => {
                    const Icon = KIND_ICON[k];
                    return (
                      <SelectItem key={k} value={k}>
                        <Icon className="size-4" />
                        {KIND_LABEL[k]}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Repo</span>
              <Input
                value={repository}
                placeholder="owner/repo"
                className="w-44 font-mono"
                onChange={(e) => setRepository(e.target.value)}
              />
            </div>
          </div>

          {searchError ? (
            <EmptyState
              title="Memory search unavailable"
              subtitle={searchError}
              icon={Search}
            />
          ) : searching && hits.length === 0 ? (
            <EmptyState subtitle="Searching…" icon={Search} />
          ) : hits.length === 0 ? (
            query.trim() === "" ? (
              <EmptyState
                title="No memories indexed yet"
                subtitle="Click “Reindex memories” to build your recall index from past sessions."
                icon={BrainCircuit}
              />
            ) : (
              <EmptyState subtitle={`No memories match “${query.trim()}”.`} icon={Search} />
            )
          ) : (
            <>
              {query.trim() === "" && (
                <p className="text-xs font-medium text-muted-foreground">
                  Recent memories ({hits.length})
                </p>
              )}
              <ScrollArea className="max-h-[70vh] pr-3">
                <div className="grid gap-3 sm:grid-cols-2">
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
              </ScrollArea>
            </>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Repository</span>
              <Input
                value={recallRepo}
                placeholder="owner/repo"
                className="font-mono"
                onChange={(e) => setRecallRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runRecall();
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Branch</span>
              <Input
                value={recallBranch}
                placeholder="(optional)"
                className="w-44 font-mono"
                onChange={(e) => setRecallBranch(e.target.value)}
              />
            </div>
            <Button
              type="button"
              onClick={() => void runRecall()}
              disabled={!recallRepo.trim() || recalling}
            >
              <BrainCircuit className="size-4" />
              Recall
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void copyPack()}
              disabled={!pack || isRecallEmpty(pack)}
            >
              <Copy className="size-4" />
              Copy context pack
            </Button>
          </div>

          {recallError ? (
            <EmptyState title="Recall unavailable" subtitle={recallError} icon={BrainCircuit} />
          ) : !recallSubmitted ? (
            <EmptyState
              title="Recall a repository’s context"
              subtitle="Enter a repo to gather its decisions, open todos, and key files."
              icon={Sparkles}
            />
          ) : recalling ? (
            <EmptyState subtitle="Recalling…" icon={BrainCircuit} />
          ) : pack && isRecallEmpty(pack) ? (
            <EmptyState subtitle="No memories recalled for this repository yet." icon={BrainCircuit} />
          ) : pack ? (
            <ScrollArea className="max-h-[70vh] pr-3">
              <div className="space-y-3">
                <RecallGroup title="Decisions" memories={pack.decisions} onResume={resume} />
                <RecallGroup title="Open todos" memories={pack.todos} onResume={resume} />
                <RecallGroup title="Summaries" memories={pack.summaries} onResume={resume} />
                {pack.files.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <File className="size-4 text-muted-foreground" />
                      Key files
                      <Badge variant="secondary">{pack.files.length}</Badge>
                    </h3>
                    <ul className="space-y-1">
                      {pack.files.map((f) => (
                        <li
                          key={f}
                          className="truncate rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground"
                          title={f}
                        >
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : null}
        </>
      )}
    </section>
  );
}

interface EmptyStateProps {
  title?: string;
  subtitle?: string;
  icon: LucideIcon;
}

function EmptyState({ title, subtitle, icon: Icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground" />
      {title && <p className="text-sm font-semibold">{title}</p>}
      {subtitle && <p className="max-w-md text-sm text-muted-foreground">{subtitle}</p>}
    </div>
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
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <Badge variant="secondary">{memories.length}</Badge>
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
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
  const Icon = KIND_ICON[memory.kind];
  return (
    <Card className="gap-3 py-0">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">
            <Icon className="size-3" />
            {KIND_LABEL[memory.kind]}
          </Badge>
          {memory.title && (
            <span className="truncate text-sm font-semibold" title={memory.title}>
              {memory.title}
            </span>
          )}
          {score !== undefined && (
            <span
              className="ml-auto font-mono text-xs text-muted-foreground"
              title="Relevance score"
            >
              {score.toFixed(2)}
            </span>
          )}
        </div>

        <p className="line-clamp-4 text-sm text-foreground/90">{body}</p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {memory.repository && (
            <span className="truncate font-mono" title={memory.repository}>
              {memory.repository}
            </span>
          )}
          {memory.branch && (
            <span className="flex items-center gap-1 font-mono">
              <GitBranch className="size-3" />
              {memory.branch}
            </span>
          )}
          <span
            className="flex items-center gap-1"
            title={new Date(memory.updatedAt).toLocaleString()}
          >
            <Clock className="size-3" />
            {relativeTime(new Date(memory.updatedAt).toISOString())}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => onResume(memory.sessionId, memory.title)}
          >
            <Play className="size-4" />
            Resume session
          </Button>
        </div>
      </div>
    </Card>
  );
}
