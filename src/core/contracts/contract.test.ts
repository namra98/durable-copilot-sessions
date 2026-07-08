import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface BackendContract {
  kind: string;
  version: number;
  routes: Array<{ method: string; path: string }>;
  cli: { commands: Array<{ name: string }> };
  state: {
    schemas: {
      AppConfig: { requiredFields: string[] };
      Workspace: { requiredFields: string[] };
      ManagedSession: { requiredFields: string[] };
      WorkspaceExport: { requiredFields: string[]; kind: string; version: number };
      WorkspaceYaml: { readOnly: boolean; fields: string[] };
    };
  };
  fixtures: Record<string, string>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const contractPath = path.join(repoRoot, "contracts", "backend-api.v1.json");
const serverPath = path.join(repoRoot, "src", "server", "app.ts");
const cliPath = path.join(repoRoot, "src", "cli", "index.ts");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function contract(): BackendContract {
  return readJson<BackendContract>(contractPath);
}

function routeKeysFromContract(value: BackendContract): string[] {
  return value.routes
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .sort();
}

function routeKeysFromServer(): string[] {
  const source = fs.readFileSync(serverPath, "utf8");
  const matches = source.matchAll(/api\.(get|post|put|patch|delete)\("([^"]+)"/g);
  return Array.from(matches, ([, method, route]) => `${method.toUpperCase()} ${route}`).sort();
}

function commandNamesFromContract(value: BackendContract): string[] {
  return value.cli.commands.map((command) => command.name).sort();
}

function commandNamesFromCli(): string[] {
  const source = fs.readFileSync(cliPath, "utf8");
  const matches = source.matchAll(/\.command\("([^"\s]+)/g);
  return Array.from(matches, ([, command]) => command).sort();
}

function fixturePath(value: BackendContract, key: string): string {
  const relative = value.fixtures[key];
  if (!relative) {
    throw new Error(`Missing fixture mapping: ${key}`);
  }
  return path.join(repoRoot, relative);
}

function expectRequiredKeys(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    expect(record, `missing ${key}`).toHaveProperty(key);
  }
}

describe("backend contract freeze", () => {
  it("tracks every Express API route", () => {
    expect(routeKeysFromContract(contract())).toEqual(routeKeysFromServer());
  });

  it("tracks every CLI command", () => {
    expect(commandNamesFromContract(contract())).toEqual(commandNamesFromCli());
  });

  it("keeps golden fixture paths present and parseable", () => {
    const value = contract();
    for (const fixture of Object.values(value.fixtures)) {
      const file = path.join(repoRoot, fixture);
      expect(fs.existsSync(file), file).toBe(true);
      if (file.endsWith(".json")) {
        expect(() => readJson<unknown>(file)).not.toThrow();
      }
    }
  });

  it("freezes owned state JSON field names", () => {
    const value = contract();
    const config = readJson<Record<string, unknown>>(fixturePath(value, "appConfig"));
    const managed = readJson<Record<string, unknown>>(fixturePath(value, "managedSession"));
    const workspace = readJson<Record<string, unknown>>(fixturePath(value, "workspace"));
    const exportEnvelope = readJson<Record<string, unknown>>(fixturePath(value, "workspaceExport"));

    expectRequiredKeys(config, value.state.schemas.AppConfig.requiredFields);
    expectRequiredKeys(managed, value.state.schemas.ManagedSession.requiredFields);
    expectRequiredKeys(workspace, value.state.schemas.Workspace.requiredFields);
    expectRequiredKeys(exportEnvelope, value.state.schemas.WorkspaceExport.requiredFields);
    expect(exportEnvelope.kind).toBe(value.state.schemas.WorkspaceExport.kind);
    expect(exportEnvelope.version).toBe(value.state.schemas.WorkspaceExport.version);
  });

  it("freezes Copilot workspace.yaml field names as read-only input", () => {
    const value = contract();
    const raw = fs.readFileSync(fixturePath(value, "workspaceYaml"), "utf8");
    const yaml = parse(raw) as Record<string, unknown>;

    expect(value.state.schemas.WorkspaceYaml.readOnly).toBe(true);
    expectRequiredKeys(yaml, ["id", "cwd", "repository", "branch", "client_name", "name"]);
    expect(value.state.schemas.WorkspaceYaml.fields).toContain("branch_of");
    expect(value.state.schemas.WorkspaceYaml.fields).toContain("branch_note");
  });
});
