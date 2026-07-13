import { describe, expect, it } from "vitest";
import type { Memory, MemoryRecallPack } from "./apiTypes";
import { buildContextPack, isRecallEmpty } from "./contextPack";

function mem(partial: Partial<Memory> & Pick<Memory, "id" | "kind" | "content">): Memory {
  return {
    sessionId: "s1",
    sourceTable: "checkpoints",
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

describe("buildContextPack", () => {
  it("renders titled sections for decisions, todos, summaries, and files", () => {
    const pack: MemoryRecallPack = {
      repository: "octo/repo",
      branch: "main",
      decisions: [mem({ id: "d1", kind: "decision", title: "Auth", content: "Use JWT tokens" })],
      todos: [mem({ id: "t1", kind: "todo", content: "Wire up logout" })],
      summaries: [mem({ id: "s1", kind: "summary", content: "Refactored API layer" })],
      files: ["src/auth.ts", "src/server/index.ts"],
    };
    const md = buildContextPack(pack);

    expect(md).toContain("# Context pack: octo/repo @ main");
    expect(md).toContain("## Decisions");
    expect(md).toContain("- **Auth** — Use JWT tokens");
    expect(md).toContain("## Open todos");
    expect(md).toContain("- Wire up logout");
    expect(md).toContain("## Summaries");
    expect(md).toContain("## Key files");
    expect(md).toContain("- `src/auth.ts`");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("omits empty sections and notes when nothing was recalled", () => {
    const pack: MemoryRecallPack = {
      repository: "octo/repo",
      decisions: [],
      todos: [],
      summaries: [],
      files: [],
    };
    const md = buildContextPack(pack);
    expect(md).toContain("# Context pack: octo/repo");
    expect(md).not.toContain("## Decisions");
    expect(md).toContain("_No memories recalled");
  });
});

describe("isRecallEmpty", () => {
  it("is true only when every section is empty", () => {
    const empty: MemoryRecallPack = { decisions: [], todos: [], summaries: [], files: [] };
    expect(isRecallEmpty(empty)).toBe(true);
    expect(isRecallEmpty({ ...empty, files: ["a"] })).toBe(false);
    expect(
      isRecallEmpty({ ...empty, todos: [mem({ id: "t", kind: "todo", content: "x" })] }),
    ).toBe(false);
  });
});
