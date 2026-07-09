import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installStartupRestore,
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
});
