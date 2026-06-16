/**
 * Barrel for the local, private memory/recall layer.
 *
 * Exposes the writable memory store factory, its public type, and the pure
 * extractor used to derive memories from Copilot's read-only session store.
 */
export { createMemoryStore, type MemoryStore } from "./store.js";
export { extractMemories } from "./extractor.js";
