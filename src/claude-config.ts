import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "filesystem-with-rewind";

export interface ClaudeServerConfig {
  command: string;
  args: string[];
}

export interface ConfigUpdateResult {
  filename: string;
  backup?: string;
  changed: boolean;
  config: Record<string, unknown>;
}

interface UpdateOptions {
  filename?: string;
  dryRun?: boolean;
  now?: Date;
}

export function defaultClaudeConfigPath(homeDirectory = os.homedir()): string {
  if (process.env.AGENT_REWIND_CLAUDE_CONFIG) {
    return path.resolve(process.env.AGENT_REWIND_CLAUDE_CONFIG);
  }
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
}

export function buildClaudeServerConfig(roots: string[]): ClaudeServerConfig {
  return {
    command: "npm",
    args: [
      "exec",
      "--yes",
      "--package=github:YanhanLi/agent-rewind",
      "--",
      "agent-rewind",
      ...roots,
    ],
  };
}

export function buildClaudeConfigFragment(roots: string[]): Record<string, unknown> {
  return { mcpServers: { [SERVER_NAME]: buildClaudeServerConfig(roots) } };
}

export async function installClaudeConfig(
  roots: string[],
  options: UpdateOptions = {},
): Promise<ConfigUpdateResult> {
  if (roots.length === 0) throw new Error("install claude requires at least one allowed directory");
  const filename = options.filename ?? defaultClaudeConfigPath();
  const { config, exists } = await readClaudeConfig(filename);
  const mcpServers = objectProperty(config, "mcpServers");
  const desired = buildClaudeServerConfig(roots);
  if (JSON.stringify(mcpServers[SERVER_NAME]) === JSON.stringify(desired)) {
    return { filename, changed: false, config };
  }
  mcpServers[SERVER_NAME] = desired;
  config.mcpServers = mcpServers;
  const backup = await persist(filename, config, exists, options);
  return { filename, backup, changed: true, config };
}

export async function uninstallClaudeConfig(
  options: UpdateOptions = {},
): Promise<ConfigUpdateResult> {
  const filename = options.filename ?? defaultClaudeConfigPath();
  const { config, exists } = await readClaudeConfig(filename);
  const mcpServers = objectProperty(config, "mcpServers");
  if (!(SERVER_NAME in mcpServers)) return { filename, changed: false, config };
  delete mcpServers[SERVER_NAME];
  config.mcpServers = mcpServers;
  const backup = await persist(filename, config, exists, options);
  return { filename, backup, changed: true, config };
}

export async function inspectClaudeConfig(
  filename = defaultClaudeConfigPath(),
): Promise<"configured" | "missing" | "invalid"> {
  try {
    const { config } = await readClaudeConfig(filename);
    const servers = objectProperty(config, "mcpServers");
    return SERVER_NAME in servers ? "configured" : "missing";
  } catch {
    return "invalid";
  }
}

async function readClaudeConfig(
  filename: string,
): Promise<{ config: Record<string, unknown>; exists: boolean }> {
  let source: string;
  try {
    source = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, exists: false };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Refusing to modify invalid Claude configuration: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error("Refusing to modify a non-object Claude configuration");
  return { config: parsed, exists: true };
}

function objectProperty(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error(`Claude configuration property ${key} must be an object`);
  return { ...value };
}

async function persist(
  filename: string,
  config: Record<string, unknown>,
  exists: boolean,
  options: UpdateOptions,
): Promise<string | undefined> {
  if (options.dryRun) return undefined;
  await mkdir(path.dirname(filename), { recursive: true });
  let backup: string | undefined;
  if (exists) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backup = `${filename}.backup-${stamp}`;
    await copyFile(filename, backup);
  }
  const temporary = path.join(path.dirname(filename), `.agent-rewind-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return backup;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
