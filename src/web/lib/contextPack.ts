/**
 * Pure helpers for turning recalled memory into a copy-pasteable markdown
 * "context pack" the user can drop into a new or forked session.
 *
 * DOM-free so it can be unit-tested under the node-only vitest environment.
 */
import type { Memory, MemoryRecallPack } from "../../core/types";

function bulletsFor(memories: Memory[]): string[] {
  return memories.map((m) => {
    const title = m.title?.trim();
    const body = m.content.trim().replace(/\s+/g, " ");
    if (title && title !== body) return `- **${title}** — ${body}`;
    return `- ${body || title || "(empty)"}`;
  });
}

/**
 * Build a markdown bundle from a recall pack: a header naming the repo/branch,
 * then sections for decisions, open todos, summaries, and key files. Empty
 * sections are omitted so the result stays compact.
 */
export function buildContextPack(pack: MemoryRecallPack): string {
  const lines: string[] = [];
  const scope = pack.branch ? `${pack.repository ?? "(repo)"} @ ${pack.branch}` : pack.repository;
  lines.push(`# Context pack${scope ? `: ${scope}` : ""}`);

  if (pack.decisions.length > 0) {
    lines.push("", "## Decisions", ...bulletsFor(pack.decisions));
  }
  if (pack.todos.length > 0) {
    lines.push("", "## Open todos", ...bulletsFor(pack.todos));
  }
  if (pack.summaries.length > 0) {
    lines.push("", "## Summaries", ...bulletsFor(pack.summaries));
  }
  if (pack.files.length > 0) {
    lines.push("", "## Key files", ...pack.files.map((f) => `- \`${f}\``));
  }

  if (lines.length === 1) {
    lines.push("", "_No memories recalled for this repository yet._");
  }

  return lines.join("\n") + "\n";
}

/** True when a recall pack carries no recalled content at all. */
export function isRecallEmpty(pack: MemoryRecallPack): boolean {
  return (
    pack.decisions.length === 0 &&
    pack.todos.length === 0 &&
    pack.summaries.length === 0 &&
    pack.files.length === 0
  );
}
