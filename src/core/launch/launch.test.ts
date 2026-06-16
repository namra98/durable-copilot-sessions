import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  colorToHex,
  renderLaunchScript,
  escapeWtValue,
  buildWindowArgs,
  resumeSession,
  launchWindows,
} from "./index.js";
import type { ExecResult } from "./index.js";
import type { TabSpec, WindowSpec } from "../types.js";

const createdDirs: string[] = [];

function tempScriptDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-launch-test-"));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("colorToHex", () => {
  it("resolves a known color name (case-insensitive)", () => {
    expect(colorToHex("blue")).toBe("#0000FF");
    expect(colorToHex("BLUE")).toBe("#0000FF");
  });

  it("normalizes hex with or without a leading #", () => {
    expect(colorToHex("#00ff00")).toBe("#00FF00");
    expect(colorToHex("ee82ee")).toBe("#EE82EE");
  });

  it("throws for an unknown color", () => {
    expect(() => colorToHex("not-a-color")).toThrow(/Unknown color/);
  });
});

describe("renderLaunchScript", () => {
  const baseTab: TabSpec = {
    sessionId: "11112222-3333-4444",
    title: "demo",
    color: "blue",
    cwd: "C:\\work\\repo",
    copilotArgs: ["--allow-all-tools"],
  };

  it("sets location to the cwd and resumes the session id", () => {
    const script = renderLaunchScript(baseTab);
    expect(script).toContain("Set-Location -LiteralPath 'C:\\work\\repo'");
    expect(script).toContain("--resume");
    expect(script).toContain("11112222-3333-4444");
    expect(script).toContain("--allow-all-tools");
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });

  it("single-quote-escapes a cwd containing a quote", () => {
    const script = renderLaunchScript({ ...baseTab, cwd: "C:\\o'brien" });
    expect(script).toContain("Set-Location -LiteralPath 'C:\\o''brien'");
  });
});

describe("escapeWtValue", () => {
  it("escapes semicolons so wt does not split tabs", () => {
    expect(escapeWtValue("a;b")).toBe("a\\;b");
  });
});

describe("buildWindowArgs", () => {
  const makeTab = (id: string): { spec: TabSpec; scriptPath: string } => ({
    spec: { sessionId: id, title: `tab-${id}`, color: "green", cwd: "C:\\x" },
    scriptPath: `C:\\scripts\\${id}.ps1`,
  });

  it("emits two new-tab tokens separated by a standalone ; for a new window", () => {
    const args = buildWindowArgs("new", [makeTab("a"), makeTab("b")]);
    expect(args.slice(0, 2)).toEqual(["-w", "-1"]);
    expect(args.filter((a) => a === "new-tab")).toHaveLength(2);
    expect(args).toContain("--tabColor");
    expect(args).toContain("#00FF00");

    const firstTab = args.indexOf("new-tab");
    const separator = args.indexOf(";");
    const secondTab = args.lastIndexOf("new-tab");
    expect(firstTab).toBeGreaterThanOrEqual(0);
    expect(firstTab).toBeLessThan(separator);
    expect(separator).toBeLessThan(secondTab);
  });

  it("targets the current window with 0", () => {
    const args = buildWindowArgs("current", [makeTab("a")]);
    expect(args.slice(0, 2)).toEqual(["-w", "0"]);
  });
});

describe("resumeSession", () => {
  it("does not exec wt.exe on a dry run but reports one tab", () => {
    const calls: string[][] = [];
    const exec = (args: string[]): ExecResult => {
      calls.push(args);
      return { status: 0 };
    };
    const result = resumeSession(
      { sessionId: "dryrun-session", dryRun: true },
      { scriptDir: tempScriptDir(), exec },
    );
    expect(result.ok).toBe(true);
    expect(result.tabsLaunched).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("execs wt.exe with -w-led args when not a dry run", () => {
    const calls: string[][] = [];
    const exec = (args: string[]): ExecResult => {
      calls.push(args);
      return { status: 0 };
    };
    const result = resumeSession(
      { sessionId: "live-session", window: "new" },
      { scriptDir: tempScriptDir(), exec },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(["-w", "-1"]);
  });
});

describe("launchWindows", () => {
  it("execs wt.exe once per window", () => {
    const calls: string[][] = [];
    const exec = (args: string[]): ExecResult => {
      calls.push(args);
      return { status: 0 };
    };
    const home = os.homedir();
    const windows: WindowSpec[] = [
      { id: "w1", tabs: [{ sessionId: "s1", title: "s1", color: "blue", cwd: home }] },
      { id: "w2", tabs: [{ sessionId: "s2", title: "s2", color: "red", cwd: home }] },
    ];
    const result = launchWindows(windows, { scriptDir: tempScriptDir(), exec });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(result.windowsOpened).toBe(2);
    expect(result.tabsLaunched).toBe(2);
  });
});
