import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installStartupRestore,
  resolveStartupDir,
  startupRestoreInstalled,
  startupRestoreScriptPath,
  uninstallStartupRestore,
} from "./startup.js";

describe("Startup restore fallback", () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "dcs-startup-"));
  }

  it("writes a hidden VBScript launcher in the Startup folder", () => {
    const dir = tempDir();
    const file = installStartupRestore('"C:\\node.exe" "C:\\cli\\index.js" restore-prompt', dir);

    expect(file).toBe(startupRestoreScriptPath(dir));
    expect(startupRestoreInstalled(dir)).toBe(true);

    const script = fs.readFileSync(file, "utf8");
    expect(script).toContain('.Run "');
    expect(script).toContain('", 0, False');
    expect(script).toContain('""C:\\node.exe"" ""C:\\cli\\index.js"" restore-prompt');
  });

  it("removes the fallback idempotently", () => {
    const dir = tempDir();
    installStartupRestore("X restore-prompt", dir);

    expect(uninstallStartupRestore(dir)).toBe(true);
    expect(uninstallStartupRestore(dir)).toBe(false);
    expect(startupRestoreInstalled(dir)).toBe(false);
  });

  it("does not count a non-file fallback path as installed", () => {
    const dir = tempDir();
    fs.mkdirSync(startupRestoreScriptPath(dir));

    expect(startupRestoreInstalled(dir)).toBe(false);
  });

  it("resolves Startup from the trusted known-folder before any fallback path", () => {
    expect(
      resolveStartupDir({
        knownFolder: () => "C:\\Users\\namra\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
        homeDir: () => "C:\\Users\\other",
      }),
    ).toBe("C:\\Users\\namra\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
  });

  it("falls back to the current user's home directory when the known folder is unavailable", () => {
    expect(
      resolveStartupDir({
        knownFolder: () => undefined,
        homeDir: () => "C:\\Users\\namra",
      }),
    ).toBe("C:\\Users\\namra\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
  });

  it("rejects non-absolute Startup fallback paths", () => {
    expect(() =>
      resolveStartupDir({
        knownFolder: () => "relative\\Startup",
        homeDir: () => "C:\\Users\\namra",
      }),
    ).toThrow(/absolute Startup fallback path/);
  });
});
