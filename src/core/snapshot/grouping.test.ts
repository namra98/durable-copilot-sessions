import { describe, it, expect } from "vitest";
import { annotateOpen } from "./grouping.js";
import type { DiscoveredSession, SessionLiveness } from "../types.js";

function session(
  id: string,
  livePids: number[],
  updatedAt: string,
  liveness: SessionLiveness = "live",
): DiscoveredSession {
  return { id, cwd: "C:/x", cwdExists: true, liveness, livePids, topLevel: true, updatedAt };
}

describe("annotateOpen", () => {
  it("elects the most-recently-updated session per PID as primary", () => {
    const sessions = [
      session("main", [10], "2026-01-02T00:00:00Z"),
      session("sub", [10], "2026-01-01T00:00:00Z"),
    ];
    const a = annotateOpen(sessions);
    expect(a.openCount).toBe(1);
    expect(a.roleById.get("main")).toBe("primary");
    expect(a.roleById.get("sub")).toBe("child");
    expect(a.childrenById.get("main")).toEqual(["sub"]);
    expect(a.groupPidById.get("main")).toBe(10);
  });

  it("counts distinct live PIDs as separate open terminals", () => {
    const sessions = [
      session("a", [1], "2026-01-01T00:00:00Z"),
      session("b", [2], "2026-01-01T00:00:00Z"),
    ];
    expect(annotateOpen(sessions).openCount).toBe(2);
  });

  it("ignores non-live sessions", () => {
    expect(annotateOpen([session("a", [], "2026-01-01T00:00:00Z", "inactive")]).openCount).toBe(0);
  });

  it("a child shared across PIDs is attached, not double-counted as open", () => {
    // 'shared' is live under pids 1 and 2 but is the newest in neither.
    const sessions = [
      session("primaryA", [1], "2026-02-01T00:00:00Z"),
      session("primaryB", [2], "2026-02-01T00:00:00Z"),
      session("shared", [1, 2], "2026-01-01T00:00:00Z"),
    ];
    const a = annotateOpen(sessions);
    expect(a.openCount).toBe(2);
    expect(a.roleById.get("shared")).toBe("child");
  });
});
