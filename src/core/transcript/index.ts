/**
 * Public surface of the transcript module: render a Copilot session's raw
 * event log into a human-readable Markdown transcript.
 */
export type { TranscriptOptions } from "./transcript.js";
export { exportTranscript, transcriptExists } from "./transcript.js";
