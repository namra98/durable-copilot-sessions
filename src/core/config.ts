import fs from "node:fs";
import type { AppConfig } from "./types.js";
import { configFile, ensureStateDirs } from "./paths.js";

/** Built-in defaults used when no config.json exists yet. */
export const defaultConfig: AppConfig = {
  apiPort: 4517,
  webPort: 4516,
  snapshotIntervalMinutes: 5,
  maxAutoSnapshots: 50,
  colorStrategy: "by-repo",
  autoOpenBrowser: true,
  windowGrouping: "by-repo",
  copilotCommand: "copilot",
  copilotArgs: [],
  restoreOnLogin: "prompt",
};

/**
 * Load configuration, merging any persisted overrides over the defaults.
 * Never throws: a missing or corrupt file falls back to defaults.
 */
export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

/** Persist configuration atomically. */
export function saveConfig(config: AppConfig): void {
  ensureStateDirs();
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, configFile);
}
