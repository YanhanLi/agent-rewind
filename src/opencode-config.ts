import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import {
  buildLaunchCommand,
  type ConfigUpdateResult,
  persistConfigSource,
  SERVER_NAME,
  type UpdateOptions,
} from "./config-file.js";

const SCHEMA = "https://opencode.ai/config.json";

export interface OpenCodeServerConfig {
  type: "local";
  command: string[];
  enabled: true;
  timeout: number;
}

export function defaultOpenCodeConfigPath(homeDirectory = os.homedir()): string {
  const configured = process.env.AGENT_REWIND_OPENCODE_CONFIG ?? process.env.OPENCODE_CONFIG;
  if (configured) return path.resolve(configured);
  const directory = path.join(homeDirectory, ".config", "opencode");
  const json = path.join(directory, "opencode.json");
  const jsonc = path.join(directory, "opencode.jsonc");
  return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
}

export function buildOpenCodeServerConfig(roots: string[]): OpenCodeServerConfig {
  return {
    type: "local",
    command: buildLaunchCommand(roots),
    enabled: true,
    timeout: 120_000,
  };
}

export function buildOpenCodeConfigFragment(roots: string[]): Record<string, unknown> {
  return {
    $schema: SCHEMA,
    mcp: { [SERVER_NAME]: buildOpenCodeServerConfig(roots) },
  };
}

export async function installOpenCodeConfig(
  roots: string[],
  options: UpdateOptions = {},
): Promise<ConfigUpdateResult> {
  if (roots.length === 0) throw new Error("install opencode requires at least one allowed directory");
  const filename = options.filename ?? defaultOpenCodeConfigPath();
  const current = await readOpenCodeConfig(filename);
  const mcp = objectProperty(current.config, "mcp");
  const desired = buildOpenCodeServerConfig(roots);
  if (JSON.stringify(mcp[SERVER_NAME]) === JSON.stringify(desired)) {
    return { filename, changed: false, config: current.config };
  }
  const source = updateProperty(current.source, ["mcp", SERVER_NAME], desired);
  const config = parseConfig(source, filename);
  const backup = await persistConfigSource(filename, source, current.exists, options);
  return { filename, backup, changed: true, config };
}

export async function uninstallOpenCodeConfig(
  options: UpdateOptions = {},
): Promise<ConfigUpdateResult> {
  const filename = options.filename ?? defaultOpenCodeConfigPath();
  const current = await readOpenCodeConfig(filename);
  const mcp = objectProperty(current.config, "mcp");
  if (!(SERVER_NAME in mcp)) return { filename, changed: false, config: current.config };
  const source = updateProperty(current.source, ["mcp", SERVER_NAME], undefined);
  const config = parseConfig(source, filename);
  const backup = await persistConfigSource(filename, source, current.exists, options);
  return { filename, backup, changed: true, config };
}

export async function inspectOpenCodeConfig(
  filename = defaultOpenCodeConfigPath(),
): Promise<"configured" | "missing" | "invalid"> {
  try {
    const { config } = await readOpenCodeConfig(filename);
    return SERVER_NAME in objectProperty(config, "mcp") ? "configured" : "missing";
  } catch {
    return "invalid";
  }
}

async function readOpenCodeConfig(
  filename: string,
): Promise<{ source: string; config: Record<string, unknown>; exists: boolean }> {
  try {
    const source = await readFile(filename, "utf8");
    return { source, config: parseConfig(source, filename), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const source = `${JSON.stringify({ $schema: SCHEMA }, null, 2)}\n`;
    return { source, config: parseConfig(source, filename), exists: false };
  }
}

function parseConfig(source: string, filename: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(source.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    throw new Error(
      `Refusing to modify invalid OpenCode configuration at ${filename}: ${printParseErrorCode(errors[0].error)}`,
    );
  }
  if (!isObject(value)) {
    throw new Error("Refusing to modify a non-object OpenCode configuration");
  }
  return value;
}

function updateProperty(source: string, property: Array<string>, value: unknown): string {
  const edits = modify(source, property, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return applyEdits(source, edits);
}

function objectProperty(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error(`OpenCode configuration property ${key} must be an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
