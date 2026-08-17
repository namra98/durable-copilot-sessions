#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exeName = process.platform === "win32" ? "dcs-rs.exe" : "dcs-rs";
const candidates = [
  process.env.DCS_RS_BIN,
  path.join(root, "target", "dcs-release", "release", exeName),
  path.join(root, "target", "release", exeName),
  path.join(root, "target", "debug", exeName),
].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

const binary = candidates.find((candidate) => existsSync(candidate));

if (!binary) {
  console.error(
    [
      "Unable to find the Rust dcs binary.",
      "Run `npm run build:rust` from the repository root, or set DCS_RS_BIN to a built dcs-rs executable.",
      `Checked: ${candidates.join(", ")}`,
    ].join("\n"),
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(`Failed to start ${binary}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`${binary} terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
