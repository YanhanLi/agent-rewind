import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistConfigSource } from "./config-file.js";
import type { GuardState, GuardUpdateResult } from "./guard-model.js";

const PLUGIN_NAME = "agent-rewind-guard.js";

export function defaultOpenCodeGuardPath(homeDirectory = os.homedir()): string {
  if (process.env.AGENT_REWIND_OPENCODE_GUARD) {
    return path.resolve(process.env.AGENT_REWIND_OPENCODE_GUARD);
  }
  const configDirectory = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(homeDirectory, ".config", "opencode");
  return path.join(configDirectory, "plugins", PLUGIN_NAME);
}

export function openCodeGuardSource(): string {
  return `// Managed by Agent Rewind. Direct edits are blocked; shell commands remain outside the guard.
const blocked = new Set(["edit", "write", "apply_patch"]);

export const AgentRewindGuard = async () => ({
  "tool.execute.before": async (input) => {
    if (blocked.has(input.tool)) {
      throw new Error(
        "Blocked by Agent Rewind guard. Use the filesystem-with-rewind MCP write_file or edit_file tool instead."
      );
    }
  },
});
`;
}

export async function installOpenCodeGuard(
  options: { filename?: string; dryRun?: boolean } = {},
): Promise<GuardUpdateResult> {
  const filename = options.filename ?? defaultOpenCodeGuardPath();
  const source = openCodeGuardSource();
  const current = await readOptional(filename);
  if (current === source) return { changed: false, files: [filename], preview: { [filename]: source } };
  if (current !== undefined) {
    throw new Error(`Refusing to overwrite an existing non-Agent-Rewind plugin: ${filename}`);
  }
  await persistConfigSource(filename, source, false, { dryRun: options.dryRun });
  return { changed: true, files: [filename], preview: { [filename]: source } };
}

export async function uninstallOpenCodeGuard(
  options: { filename?: string; dryRun?: boolean } = {},
): Promise<GuardUpdateResult> {
  const filename = options.filename ?? defaultOpenCodeGuardPath();
  const source = openCodeGuardSource();
  const current = await readOptional(filename);
  if (current === undefined) return { changed: false, files: [filename], preview: {} };
  if (current !== source) {
    throw new Error(`Refusing to remove a modified OpenCode guard plugin: ${filename}`);
  }
  if (!options.dryRun) await rm(filename);
  return { changed: true, files: [filename], preview: { [filename]: source } };
}

export async function inspectOpenCodeGuard(
  filename = defaultOpenCodeGuardPath(),
): Promise<GuardState> {
  const current = await readOptional(filename);
  if (current === undefined) return "missing";
  return current === openCodeGuardSource() ? "configured" : "conflict";
}

async function readOptional(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
