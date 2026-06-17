import fs from "node:fs";
import path from "node:path";
import { copilotSessionStateDir } from "../paths.js";

/**
 * Options for rendering a session transcript. Both fields are optional so the
 * common case (`exportTranscript(id)`) reads from the real Copilot state dir
 * while tests can point `stateDir` at a hermetic temp directory.
 */
export interface TranscriptOptions {
  stateDir?: string;
  maxChars?: number;
}

/** Default cap applied to any single message body. */
const DEFAULT_MAX_CHARS = 8000;

/** Absolute path to a session's raw events file. */
function eventsPath(sessionId: string, stateDir: string): string {
  return path.join(stateDir, sessionId, "events.jsonl");
}

/**
 * Pull the best human-readable text out of a parsed event. Copilot writes the
 * payload under `data` with no single stable key, so we probe the common
 * shapes and fall back to scanning for the first string-valued field.
 */
function extractText(event: Record<string, unknown>): string {
  const data = event.data;
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["text", "content", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  for (const key of ["text", "content", "message"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/** Truncate a message body, appending an ellipsis marker when it was cut. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Read a session's `events.jsonl` and render it as a Markdown transcript with
 * alternating `### You` / `### Copilot` sections. Unparseable lines and
 * non-message events (tool calls, etc.) are skipped, and the function never
 * throws on bad input — a missing file yields a short markdown note instead.
 */
export function exportTranscript(sessionId: string, opts?: TranscriptOptions): string {
  const stateDir = opts?.stateDir ?? copilotSessionStateDir;
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const file = eventsPath(sessionId, stateDir);

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return `# Transcript\n\nNo transcript found for ${sessionId}\n`;
  }

  const sections: string[] = [`# Transcript: ${sessionId}\n`];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event.type;
    let heading: string;
    if (type === "user.message") {
      heading = "### You";
    } else if (type === "assistant.message") {
      heading = "### Copilot";
    } else {
      continue;
    }

    const text = extractText(event).trim();
    if (text.length === 0) continue;

    sections.push(`${heading}\n\n${truncate(text, maxChars)}\n`);
  }

  return `${sections.join("\n")}`;
}

/** True when a session's `events.jsonl` exists and is a regular file. */
export function transcriptExists(sessionId: string, stateDir?: string): boolean {
  const dir = stateDir ?? copilotSessionStateDir;
  try {
    return fs.statSync(eventsPath(sessionId, dir)).isFile();
  } catch {
    return false;
  }
}
