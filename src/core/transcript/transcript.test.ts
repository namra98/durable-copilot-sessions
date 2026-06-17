import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportTranscript, transcriptExists } from "./transcript.js";

const SESSION_ID = "abcdef01-2345-6789-abcd-ef0123456789";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

const USER_TEXT = "How do I export a transcript?";
const ASSISTANT_TEXT = "Call exportTranscript with the session id.";
const TOOL_TEXT = "should-not-appear-in-output";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-transcript-"));
  const sessionDir = path.join(stateDir, SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "session.start", data: { id: SESSION_ID } }),
    JSON.stringify({ type: "user.message", data: { text: USER_TEXT } }),
    JSON.stringify({ type: "assistant.message", data: { content: ASSISTANT_TEXT } }),
    JSON.stringify({ type: "tool.call", data: { text: TOOL_TEXT } }),
    "{ this is not valid json",
  ];
  fs.writeFileSync(path.join(sessionDir, "events.jsonl"), lines.join("\n"), "utf8");
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("exportTranscript", () => {
  it("renders user and assistant messages with headings", () => {
    const md = exportTranscript(SESSION_ID, { stateDir });
    expect(md).toContain(`# Transcript: ${SESSION_ID}`);
    expect(md).toContain("### You");
    expect(md).toContain(USER_TEXT);
    expect(md).toContain("### Copilot");
    expect(md).toContain(ASSISTANT_TEXT);
  });

  it("skips tool events and malformed lines", () => {
    const md = exportTranscript(SESSION_ID, { stateDir });
    expect(md).not.toContain(TOOL_TEXT);
    expect(md).not.toContain("not valid json");
  });

  it("truncates messages longer than maxChars", () => {
    const md = exportTranscript(SESSION_ID, { stateDir, maxChars: 5 });
    expect(md).toContain(`${USER_TEXT.slice(0, 5)}…`);
    expect(md).not.toContain(USER_TEXT);
  });

  it("returns a note when the session is missing", () => {
    const md = exportTranscript(MISSING_ID, { stateDir });
    expect(md).toContain(`No transcript found for ${MISSING_ID}`);
  });
});

describe("transcriptExists", () => {
  it("is true for an existing session", () => {
    expect(transcriptExists(SESSION_ID, stateDir)).toBe(true);
  });

  it("is false for a missing session", () => {
    expect(transcriptExists(MISSING_ID, stateDir)).toBe(false);
  });
});
