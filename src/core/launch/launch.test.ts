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
  resolveExecutable,
  preflight,
} from "./index.js";
import type { ExecResult } from "./index.js";
import type { TabSpec, WindowSpec } from "../types.js";

const createdDirs: string[] = [];

/** A resolver that pretends every executable is present (hermetic launches). */
const resolveAll = (name: string): string => `C:\\fake\\${name}.exe`;

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

  it("uses a custom launch command when provided", () => {
    const script = renderLaunchScript({ ...baseTab, copilotArgs: ["copilot", "--yolo"] }, "agency");
    expect(script).toContain("& 'agency' 'copilot' '--yolo' '--resume' '11112222-3333-4444'");
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
      { scriptDir: tempScriptDir(), exec, resolve: resolveAll },
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
      { scriptDir: tempScriptDir(), exec, resolve: resolveAll },
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
    const result = launchWindows(windows, { scriptDir: tempScriptDir(), exec, resolve: resolveAll });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(result.windowsOpened).toBe(2);
    expect(result.tabsLaunched).toBe(2);
  });
});

describe("execution policy and cwd fallback (review fixes)", () => {
  it("buildWindowArgs runs the script under -ExecutionPolicy Bypass -NoProfile", () => {
    const tab: TabSpec = { sessionId: "s", title: "t", color: "green", cwd: "C:/x" };
    const args = buildWindowArgs("new", [{ spec: tab, scriptPath: "C:/script.ps1" }]);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-ExecutionPolicy");
    expect(args).toContain("Bypass");
  });

  it("resumeSession warns (not silent success) when the cwd does not exist", () => {
    const missing = path.join(os.tmpdir(), `dcs-missing-${Date.now()}`);
    const result = resumeSession(
      { sessionId: "abc", cwd: missing, dryRun: true },
      { scriptDir: tempScriptDir(), resolve: resolveAll },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("does not exist");
  });
});

describe("resolveExecutable (PATHEXT)", () => {
  function tempPathDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-path-test-"));
    createdDirs.push(dir);
    return dir;
  }

  function nativeRealPath(file: string): string {
    return fs.realpathSync.native(file);
  }

  it("finds a .cmd shim for a bare name using PATHEXT", () => {
    const dir = tempPathDir();
    const shim = path.join(dir, "copilot.cmd");
    fs.writeFileSync(shim, "@echo off");
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.CMD;.PS1" } as NodeJS.ProcessEnv;
    expect(resolveExecutable("copilot", env)).toBe(nativeRealPath(shim));
  });

  it("finds a .ps1 shim and respects PATHEXT ordering", () => {
    const dir = tempPathDir();
    const shim = path.join(dir, "copilot.ps1");
    fs.writeFileSync(shim, "# noop");
    const env = { PATH: dir, PATHEXT: ".EXE;.PS1" } as NodeJS.ProcessEnv;
    expect(resolveExecutable("copilot", env)).toBe(nativeRealPath(shim));
  });

  it("resolves a name that already carries an extension verbatim", () => {
    const dir = tempPathDir();
    const exe = path.join(dir, "wt.exe");
    fs.writeFileSync(exe, "");
    const env = { PATH: dir, PATHEXT: ".EXE" } as NodeJS.ProcessEnv;
    expect(resolveExecutable("wt.exe", env)).toBe(nativeRealPath(exe));
  });

  it("returns undefined for an injected env when the executable is absent", () => {
    const dir = tempPathDir();
    const env = { PATH: dir, PATHEXT: ".EXE;.CMD" } as NodeJS.ProcessEnv;
    expect(resolveExecutable("does-not-exist", env)).toBeUndefined();
  });

  it("does not match a .cmd when PATHEXT omits .CMD", () => {
    const dir = tempPathDir();
    fs.writeFileSync(path.join(dir, "copilot.cmd"), "@echo off");
    const env = { PATH: dir, PATHEXT: ".EXE" } as NodeJS.ProcessEnv;
    expect(resolveExecutable("copilot", env)).toBeUndefined();
  });
});

describe("preflight", () => {
  it("reports both names missing when nothing resolves", () => {
    const result = preflight({ resolve: () => undefined });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["wt", "copilot"]);
  });

  it("reports only copilot missing when wt resolves", () => {
    const result = preflight({
      resolve: (name) => (name === "wt" ? "C:\\wt.exe" : undefined),
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["copilot"]);
  });

  it("is ok when both resolve", () => {
    const result = preflight({ resolve: (name) => `C:\\${name}.exe` });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe("launcher executable preflight", () => {
  it("returns a clear wt.exe-not-found error instead of an opaque spawn failure", () => {
    let execCalls = 0;
    const result = resumeSession(
      { sessionId: "s", window: "new" },
      {
        scriptDir: tempScriptDir(),
        exec: () => {
          execCalls += 1;
          return { status: 0 };
        },
        resolve: () => undefined,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Windows Terminal (wt.exe) was not found on PATH");
    expect(execCalls).toBe(0);
  });

  it("adds a copilot warning when only copilot is missing", () => {
    const result = resumeSession(
      { sessionId: "s", window: "new" },
      {
        scriptDir: tempScriptDir(),
        exec: () => ({ status: 0 }),
        resolve: (name) => (name === "copilot" ? undefined : `C:\\${name}.exe`),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /copilot/i.test(w))).toBe(true);
  });

  it("launchWindows fails fast when wt.exe cannot be resolved", () => {
    const home = os.homedir();
    const windows: WindowSpec[] = [
      { id: "w1", tabs: [{ sessionId: "s1", title: "s1", color: "blue", cwd: home }] },
    ];
    let execCalls = 0;
    const result = launchWindows(windows, {
      scriptDir: tempScriptDir(),
      exec: () => {
        execCalls += 1;
        return { status: 0 };
      },
      resolve: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Windows Terminal (wt.exe) was not found on PATH");
    expect(execCalls).toBe(0);
  });
});
