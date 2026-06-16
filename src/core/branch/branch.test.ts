import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { branchSession } from "./branch.js";

let stateDir: string;
const PARENT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW_ID = "bbbbbbbb-5555-6666-7777-888888888888";

function writeParent(): void {
  const dir = path.join(stateDir, PARENT_ID);
  fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
  fs.mkdirSync(path.join(dir, "rewind-snapshots", "backups", "snap1"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workspace.yaml"),
    "id: " + PARENT_ID + "\ncwd: C:/repo/x\nname: Design The Thing\nuser_named: false\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    JSON.stringify({ type: "session.start", data: { sessionId: PARENT_ID, name: "Design The Thing", alreadyInUse: true } }) +
      "\n" +
      JSON.stringify({ type: "user.message", data: { text: "hi" } }) +
      "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "session.db"), "SQLITEDB", "utf8");
  fs.writeFileSync(path.join(dir, "inuse.4242.lock"), "4242", "utf8");
  fs.writeFileSync(path.join(dir, "checkpoints", "index.md"), "# old checkpoints\nstuff\n", "utf8");
  fs.writeFileSync(path.join(dir, "rewind-snapshots", "backups", "snap1", "f.txt"), "x", "utf8");
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-branch-" + randomUUID() + "-"));
  writeParent();
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("branchSession", () => {
  it("creates a new session with lineage, resetting volatile state", () => {
    const result = branchSession(PARENT_ID, { stateDir, newId: NEW_ID, note: "trying an idea" });
    expect(result.newSessionId).toBe(NEW_ID);
    expect(result.newSessionName).toMatch(/^Branch: Design The Thing \[bbbbbbbb\]/);

    const dir = path.join(stateDir, NEW_ID);
    expect(fs.existsSync(dir)).toBe(true);

    const ws = parse(fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8"));
    expect(ws.id).toBe(NEW_ID);
    expect(ws.branch_of).toBe(PARENT_ID);
    expect(ws.user_named).toBe(true);
    expect(String(ws.name)).toMatch(/^Branch:/);
    expect(ws.branch_note).toBe("trying an idea");
    expect(ws.cwd).toBe("C:/repo/x");

    // Volatile state reset / not copied.
    expect(fs.existsSync(path.join(dir, "session.db"))).toBe(false);
    expect(fs.readdirSync(dir).some((f) => /^inuse\./.test(f))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "checkpoints", "index.md"), "utf8")).toContain("# Checkpoint History");
    expect(fs.existsSync(path.join(dir, "rewind-snapshots", "backups", "snap1"))).toBe(false);

    // events.jsonl session.start rewritten.
    const first = JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n")[0]);
    expect(first.type).toBe("session.start");
    expect(first.data.sessionId).toBe(NEW_ID);
    expect(first.data.alreadyInUse).toBe(false);
    expect(first.data.name).toMatch(/^Branch:/);
  });

  it("never modifies the parent session", () => {
    branchSession(PARENT_ID, { stateDir, newId: NEW_ID });
    const parentWs = parse(fs.readFileSync(path.join(stateDir, PARENT_ID, "workspace.yaml"), "utf8"));
    expect(parentWs.id).toBe(PARENT_ID);
    expect(parentWs.branch_of).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, PARENT_ID, "session.db"))).toBe(true);
  });

  it("rejects a missing parent and an existing destination", () => {
    expect(() => branchSession("nope", { stateDir, newId: NEW_ID })).toThrow(/Missing workspace/);
    branchSession(PARENT_ID, { stateDir, newId: NEW_ID });
    expect(() => branchSession(PARENT_ID, { stateDir, newId: NEW_ID })).toThrow(/already exists/);
  });
});
