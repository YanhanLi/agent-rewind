import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildLaunchCommand,
  type ConfigUpdateResult,
  SERVER_NAME,
} from "./config-file.js";

const execFileAsync = promisify(execFile);

interface CodexTransport {
  type: "stdio";
  command: string;
  args: string[];
}

interface CodexServerConfig {
  name: string;
  enabled: boolean;
  transport: CodexTransport;
}

interface CodexOptions {
  dryRun?: boolean;
  run?: CodexRunner;
}

export type CodexRunner = (args: string[]) => Promise<string>;

export function defaultCodexConfigPath(homeDirectory = os.homedir()): string {
  const codexHome = process.env.AGENT_REWIND_CODEX_HOME ?? process.env.CODEX_HOME;
  return path.join(codexHome ? path.resolve(codexHome) : path.join(homeDirectory, ".codex"), "config.toml");
}

export function buildCodexCommand(roots: string[]): string[] {
  return buildLaunchCommand(roots);
}

export function buildCodexConfigFragment(roots: string[]): string {
  const [command, ...args] = buildCodexCommand(roots);
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((value) => JSON.stringify(value)).join(", ")}]`,
    "",
  ].join("\n");
}

export async function installCodexConfig(
  roots: string[],
  options: CodexOptions = {},
): Promise<ConfigUpdateResult> {
  if (roots.length === 0) throw new Error("install codex requires at least one allowed directory");
  const filename = defaultCodexConfigPath();
  const desiredCommand = buildCodexCommand(roots);
  const desired = toResultConfig(desiredCommand);
  if (options.dryRun) return { filename, changed: true, config: desired };

  const run = options.run ?? defaultCodexRunner;
  const existing = await readCodexServer(run);
  if (existing && matches(existing, desiredCommand)) {
    return { filename, changed: false, config: desired };
  }
  if (existing) {
    throw new Error(
      `Codex already has a different ${SERVER_NAME} entry. Run "agent-rewind uninstall codex" before replacing it.`,
    );
  }
  await run(["mcp", "add", SERVER_NAME, "--", ...desiredCommand]);
  return { filename, changed: true, config: desired };
}

export async function uninstallCodexConfig(
  options: CodexOptions = {},
): Promise<ConfigUpdateResult> {
  const filename = defaultCodexConfigPath();
  const run = options.run ?? defaultCodexRunner;
  const existing = await readCodexServer(run);
  const config = existing ? (existing as unknown as Record<string, unknown>) : {};
  if (!existing) return { filename, changed: false, config };
  if (!options.dryRun) await run(["mcp", "remove", SERVER_NAME]);
  return { filename, changed: true, config };
}

export async function inspectCodexConfig(
  options: Pick<CodexOptions, "run"> = {},
): Promise<"configured" | "missing" | "unavailable" | "invalid"> {
  try {
    return (await readCodexServer(options.run ?? defaultCodexRunner)) ? "configured" : "missing";
  } catch (error) {
    return isMissingExecutable(error) ? "unavailable" : "invalid";
  }
}

async function readCodexServer(run: CodexRunner): Promise<CodexServerConfig | undefined> {
  let output: string;
  try {
    output = await run(["mcp", "get", SERVER_NAME, "--json"]);
  } catch (error) {
    if (errorText(error).includes(`No MCP server named '${SERVER_NAME}' found`)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Codex returned invalid JSON while inspecting its MCP configuration");
  }
  if (!isCodexServerConfig(parsed)) {
    throw new Error("Codex returned an unsupported MCP configuration shape");
  }
  return parsed;
}

async function defaultCodexRunner(args: string[]): Promise<string> {
  const env = { ...process.env };
  if (process.env.AGENT_REWIND_CODEX_HOME) env.CODEX_HOME = process.env.AGENT_REWIND_CODEX_HOME;
  const commands = process.env.AGENT_REWIND_CODEX_BIN
    ? [process.env.AGENT_REWIND_CODEX_BIN]
    : ["codex", ...(await installedCodexAppBinaries())];
  let missing: unknown;
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, { env });
      return stdout;
    } catch (error) {
      if (isMissingExecutable(error)) {
        missing = error;
        continue;
      }
      throw new Error(`Codex CLI failed: ${errorText(error)}`, { cause: error });
    }
  }
  throw new Error(`Codex CLI was not found: ${commands.join(", ")}`, { cause: missing });
}

async function installedCodexAppBinaries(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  const available = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        return undefined;
      }
    }),
  );
  return available.filter((candidate): candidate is string => candidate !== undefined);
}

function matches(config: CodexServerConfig, command: string[]): boolean {
  return (
    config.enabled &&
    config.transport.type === "stdio" &&
    config.transport.command === command[0] &&
    JSON.stringify(config.transport.args) === JSON.stringify(command.slice(1))
  );
}

function toResultConfig(command: string[]): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    enabled: true,
    transport: { type: "stdio", command: command[0], args: command.slice(1) },
  };
}

function isCodexServerConfig(value: unknown): value is CodexServerConfig {
  if (!isObject(value) || !isObject(value.transport)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.enabled === "boolean" &&
    value.transport.type === "stdio" &&
    typeof value.transport.command === "string" &&
    Array.isArray(value.transport.args) &&
    value.transport.args.every((argument) => typeof argument === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (!isObject(error)) return String(error);
  return [error.message, error.stderr, error.stdout]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isMissingExecutable(error: unknown): boolean {
  if (!isObject(error)) return false;
  return error.code === "ENOENT" || (error.cause !== undefined && isMissingExecutable(error.cause));
}
