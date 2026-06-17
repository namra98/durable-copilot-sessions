import { describe, it, expect } from "vitest";
import type { Workspace } from "../types.js";
import {
  exportWorkspaces,
  parseWorkspaceExport,
  withFreshIds,
} from "./export.js";

function makeWorkspace(): Workspace {
  return {
    id: "ws-1111",
    name: "morning-layout",
    description: "my morning setup",
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    windows: [
      {
        id: "win-1",
        label: "left",
        tabs: [
          {
            sessionId: "sess-a",
            title: "API",
            color: "#ff0000",
            cwd: "C:/repo/api",
            copilotArgs: ["--allow-all-tools"],
          },
          {
            sessionId: "sess-b",
            title: "Web",
            color: "blue",
            cwd: "C:/repo/web",
          },
        ],
      },
    ],
  };
}

describe("exportWorkspaces / parseWorkspaceExport", () => {
  it("round-trips a Workspace[] preserving meaningful fields", () => {
    const input = [makeWorkspace()];
    const json = exportWorkspaces(input);
    const out = parseWorkspaceExport(json);
    expect(out).toEqual(input);
  });

  it("produces a valid envelope shape", () => {
    const json = exportWorkspaces([makeWorkspace()]);
    const envelope = JSON.parse(json);
    expect(envelope.kind).toBe("durable-copilot-sessions/workspaces");
    expect(envelope.version).toBe(1);
    expect(typeof envelope.exportedAt).toBe("string");
    expect(Array.isArray(envelope.workspaces)).toBe(true);
  });

  it("drops unknown fields and coerces invalid source to imported", () => {
    const json = JSON.stringify({
      kind: "durable-copilot-sessions/workspaces",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      bogusTop: 42,
      workspaces: [
        {
          id: "ws-1",
          name: "n",
          source: "weird",
          createdAt: "a",
          updatedAt: "b",
          extra: "nope",
          windows: [{ id: "w", junk: 1, tabs: [] }],
        },
      ],
    });
    const out = parseWorkspaceExport(json);
    expect(out[0].source).toBe("imported");
    expect(out[0]).not.toHaveProperty("extra");
    expect(out[0].windows[0]).not.toHaveProperty("junk");
  });

  it("throws on wrong kind", () => {
    const json = JSON.stringify({ kind: "other", version: 1, workspaces: [] });
    expect(() => parseWorkspaceExport(json)).toThrow(/kind/);
  });

  it("throws on wrong version", () => {
    const json = JSON.stringify({
      kind: "durable-copilot-sessions/workspaces",
      version: 2,
      workspaces: [],
    });
    expect(() => parseWorkspaceExport(json)).toThrow(/version/);
  });

  it("throws on non-JSON input", () => {
    expect(() => parseWorkspaceExport("not json {")).toThrow(/JSON/);
  });

  it("throws on a workspace missing windows", () => {
    const json = JSON.stringify({
      kind: "durable-copilot-sessions/workspaces",
      version: 1,
      workspaces: [
        {
          id: "ws-1",
          name: "n",
          source: "manual",
          createdAt: "a",
          updatedAt: "b",
        },
      ],
    });
    expect(() => parseWorkspaceExport(json)).toThrow(/windows/);
  });
});

describe("withFreshIds", () => {
  it("changes ids but preserves names and tabs", () => {
    const input = [makeWorkspace()];
    const fresh = withFreshIds(input);
    expect(fresh[0].id).not.toBe(input[0].id);
    expect(fresh[0].name).toBe(input[0].name);
    expect(fresh[0].windows).toEqual(input[0].windows);
  });
});
