import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Edge, Node, NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphModel, GraphNode, WindowTarget } from "../../core/types";
import type { SessionFilter } from "../api/client";
import * as api from "../api/client";
import { layoutGraph, type FlowEdge, type LayoutDirection } from "../lib/graphLayout";
import { toCssColor } from "../lib/colors";
import { NodeActionsContext, SessionNode, type NodeActions } from "./SessionNode";

/** Above this many nodes we cap the canvas to stay responsive. */
const MAX_NODES = 150;

const nodeTypes: NodeTypes = { session: SessionNode };

const EDGE_LEGEND: { kind: FlowEdge["data"]["kind"]; label: string }[] = [
  { kind: "fork", label: "Fork" },
  { kind: "terminal", label: "Same terminal" },
  { kind: "repo", label: "Same repo" },
];

function edgeStyle(kind: FlowEdge["data"]["kind"]): Partial<Edge> {
  if (kind === "fork") {
    return { animated: true, style: { stroke: "#4f8cff", strokeWidth: 2 } };
  }
  if (kind === "terminal") {
    return { style: { stroke: "#9aa7ba", strokeWidth: 1.5, strokeDasharray: "5 4" } };
  }
  return { style: { stroke: "#313c4f", strokeWidth: 1, opacity: 0.55 } };
}

function toRfEdges(edges: FlowEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...edgeStyle(e.data.kind),
  }));
}

/** Cap a model to the first N nodes, dropping edges that reference dropped nodes. */
function capModel(model: GraphModel): { model: GraphModel; capped: boolean } {
  if (model.nodes.length <= MAX_NODES) return { model, capped: false };
  const kept = model.nodes.slice(0, MAX_NODES);
  const ids = new Set(kept.map((n) => n.id));
  return {
    model: {
      ...model,
      nodes: kept,
      edges: model.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    },
    capped: true,
  };
}

interface GraphViewProps {
  initialFilter: SessionFilter;
  windowTarget: WindowTarget;
  push: (kind: "success" | "error" | "info", text: string) => void;
  onShowRelated: (sessionId: string, label: string) => void;
}

/** The Graph tab: a dagre-laid-out, pan/zoom React Flow canvas of sessions. */
export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvas({ initialFilter, windowTarget, push, onShowRelated }: GraphViewProps) {
  const [filter, setFilter] = useState<SessionFilter>(
    initialFilter === "all" ? "live" : initialFilter,
  );
  const [direction, setDirection] = useState<LayoutDirection>("TB");
  const [model, setModel] = useState<GraphModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [forkTarget, setForkTarget] = useState<GraphNode | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();
  const didFit = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await api.getGraph(filter);
      const { model: capModelResult, capped: wasCapped } = capModel(fetched);
      setModel(capModelResult);
      setCapped(wasCapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setModel(null);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    didFit.current = false;
    void load();
  }, [load]);

  // (Re)layout whenever the model or direction changes, then fit the view once.
  useEffect(() => {
    if (!model) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const laid = layoutGraph(model, direction);
    setNodes(laid.nodes as unknown as Node[]);
    setEdges(toRfEdges(laid.edges));
    const id = window.setTimeout(() => {
      fitView({ padding: 0.2, duration: didFit.current ? 300 : 0 });
      didFit.current = true;
    }, 0);
    return () => window.clearTimeout(id);
  }, [model, direction, setNodes, setEdges, fitView]);

  const handleResume = useCallback(
    async (node: GraphNode) => {
      setBusyId(node.id);
      try {
        const result = await api.resumeSession(node.id, {
          window: windowTarget,
          color: node.color,
          title: node.label,
        });
        if (result.ok) push("success", `Resumed “${node.label}”`);
        else push("error", `Resume failed: ${result.error ?? "unknown error"}`);
      } catch (err) {
        push("error", `Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [windowTarget, push],
  );

  const handleNewChild = useCallback(
    (node: GraphNode) => {
      setForkTarget(node);
    },
    [],
  );

  const handleRelated = useCallback(
    (node: GraphNode) => {
      onShowRelated(node.id, node.label);
    },
    [onShowRelated],
  );

  const actions: NodeActions = useMemo(
    () => ({
      onResume: handleResume,
      onFork: (node) => setForkTarget(node),
      onNewChild: handleNewChild,
      onRelated: handleRelated,
      busyId,
    }),
    [handleResume, handleNewChild, handleRelated, busyId],
  );

  const submitFork = useCallback(
    async (note: string, launch: boolean) => {
      if (!forkTarget) return;
      const target = forkTarget;
      setBusyId(target.id);
      try {
        const result = await api.forkSession(target.id, {
          note: note || undefined,
          launch,
          color: target.color,
          window: windowTarget,
        });
        setForkTarget(null);
        const launched = result.launch?.ok ? " · launched" : "";
        push("success", `Forked “${target.label}”${launched}`);
        await load();
      } catch (err) {
        push("error", `Fork failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [forkTarget, windowTarget, push, load],
  );

  const submitNew = useCallback(
    async (body: api.NewSessionBody) => {
      try {
        const result = await api.newSession(body);
        setShowNew(false);
        if (result.ok) push("success", `Created “${body.title}”`);
        else push("error", `New session failed: ${result.error ?? "unknown error"}`);
        await load();
      } catch (err) {
        push("error", `New session failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [push, load],
  );

  return (
    <section className="panel graphpanel">
      <div className="graphbar">
        <div className="seg" role="group" aria-label="Graph filter">
          {(["open", "live", "all"] as SessionFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`seg__btn${filter === f ? " seg__btn--on" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "open" ? "Open" : f === "live" ? "Live" : "All"}
            </button>
          ))}
        </div>

        <div className="seg" role="group" aria-label="Layout direction">
          <button
            type="button"
            className={`seg__btn${direction === "TB" ? " seg__btn--on" : ""}`}
            onClick={() => setDirection("TB")}
            title="Top-down layout"
          >
            ↧ TB
          </button>
          <button
            type="button"
            className={`seg__btn${direction === "LR" ? " seg__btn--on" : ""}`}
            onClick={() => setDirection("LR")}
            title="Left-right layout"
          >
            ↦ LR
          </button>
        </div>

        <div className="graphbar__spacer" />

        <button type="button" className="btn btn--primary" onClick={() => setShowNew(true)}>
          ＋ New session
        </button>
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {capped && (
        <div className="banner banner--warn" role="status">
          Showing the first {MAX_NODES} sessions. Narrow the filter to see the rest.
        </div>
      )}

      <div className="graphcanvas">
        {error ? (
          <div className="empty empty--cta">
            <p className="empty__title">Graph unavailable</p>
            <p className="empty__sub">{error}</p>
            <button type="button" className="btn btn--primary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : loading && !model ? (
          <div className="graphcanvas__loading">Loading graph…</div>
        ) : model && model.nodes.length === 0 ? (
          <div className="empty empty--cta">
            <p className="empty__title">No sessions to graph</p>
            <p className="empty__sub">Try the “All” filter or start a Copilot session.</p>
          </div>
        ) : (
          <NodeActionsContext.Provider value={actions}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              colorMode="dark"
              fitView
              minZoom={0.2}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} color="#232b3a" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => {
                  const data = n.data as unknown as GraphNode;
                  return data?.color ? toCssColor(data.color) : "#4f8cff";
                }}
                maskColor="rgba(11,14,20,0.7)"
              />
            </ReactFlow>
          </NodeActionsContext.Provider>
        )}

        <div className="graphlegend" aria-hidden="true">
          {EDGE_LEGEND.map((l) => (
            <span key={l.kind} className="graphlegend__item">
              <span className={`graphlegend__line graphlegend__line--${l.kind}`} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      {showNew && (
        <NewSessionDialog
          windowTarget={windowTarget}
          onCancel={() => setShowNew(false)}
          onSubmit={submitNew}
        />
      )}
      {forkTarget && (
        <ForkDialog
          node={forkTarget}
          onCancel={() => setForkTarget(null)}
          onSubmit={submitFork}
        />
      )}
    </section>
  );
}

interface NewSessionDialogProps {
  windowTarget: WindowTarget;
  onCancel: () => void;
  onSubmit: (body: api.NewSessionBody) => void;
}

function NewSessionDialog({ windowTarget, onCancel, onSubmit }: NewSessionDialogProps) {
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [color, setColor] = useState("");
  const [prompt, setPrompt] = useState("");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = title.trim();
    const c = cwd.trim();
    if (!t || !c) return;
    onSubmit({
      title: t,
      cwd: c,
      color: color.trim() || undefined,
      prompt: prompt.trim() || undefined,
      window: windowTarget,
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 className="modal__title">New session</h3>

        <label className="field field--block">
          <span className="field__label">Title</span>
          <input
            className="input"
            value={title}
            autoFocus
            placeholder="api refactor"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field field--block">
          <span className="field__label">Working directory</span>
          <input
            className="input"
            value={cwd}
            placeholder="C:\\work\\repo"
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>

        <label className="field field--block">
          <span className="field__label">Color (optional)</span>
          <input
            className="input"
            value={color}
            placeholder="#4f8cff or blue"
            onChange={(e) => setColor(e.target.value)}
          />
        </label>

        <label className="field field--block">
          <span className="field__label">Starting prompt (optional)</span>
          <input
            className="input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!title.trim() || !cwd.trim()}>
            Create session
          </button>
        </div>
      </form>
    </div>
  );
}

interface ForkDialogProps {
  node: GraphNode;
  onCancel: () => void;
  onSubmit: (note: string, launch: boolean) => void;
}

function ForkDialog({ node, onCancel, onSubmit }: ForkDialogProps) {
  const [note, setNote] = useState("");
  const [launch, setLaunch] = useState(true);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit(note.trim(), launch);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Fork session"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 className="modal__title">Fork “{node.label}”</h3>
        <p className="modal__hint">Creates a branched session from this one.</p>

        <label className="field field--block">
          <span className="field__label">Lineage note (optional)</span>
          <input
            className="input"
            value={note}
            autoFocus
            placeholder="try the alternate approach"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <label className="check">
          <input type="checkbox" checked={launch} onChange={(e) => setLaunch(e.target.checked)} />
          Open a terminal tab for the fork
        </label>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary">
            Create fork
          </button>
        </div>
      </form>
    </div>
  );
}
