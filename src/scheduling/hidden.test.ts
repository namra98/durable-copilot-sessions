import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeHiddenLauncher } from "./hidden.js";

describe("writeHiddenLauncher", () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "dcs-hidden-"));
  }

  it("writes a .vbs shim and returns a wscript action string", () => {
    const dir = tempDir();
    const inner = '"C:\\node.exe" "C:\\cli\\index.js" snapshot';
    const action = writeHiddenLauncher("snapshot", inner, dir);

    const vbsPath = path.join(dir, "snapshot.vbs");
    expect(fs.existsSync(vbsPath)).toBe(true);
    expect(action).toBe(`wscript.exe //B //Nologo "${vbsPath}"`);
  });

  it("runs the command hidden (window style 0) and escapes embedded quotes", () => {
    const dir = tempDir();
    const inner = '"C:\\node.exe" "C:\\cli\\index.js" snapshot';
    writeHiddenLauncher("snapshot", inner, dir);

    const script = fs.readFileSync(path.join(dir, "snapshot.vbs"), "utf8");
    // Window style 0 = hidden, async (False).
    expect(script).toContain('.Run "');
    expect(script).toContain('", 0, False');
    // Embedded double quotes are doubled for the VBScript string literal.
    expect(script).toContain('""C:\\node.exe"" ""C:\\cli\\index.js"" snapshot');
  });
});
