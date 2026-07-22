import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { persistConfigSource } from "./config-file.js";
import type { GuardState, GuardUpdateResult } from "./guard-model.js";

interface HookHandler {
  type: "command";
  command: string;
  timeout: number;
  statusMessage: string;
}

interface HookGroup {
  matcher: string;
  hooks: HookHandler[];
}

export function defaultCodexHooksPath(homeDirectory = os.homedir()): string {
  if (process.env.AGENT_REWIND_CODEX_HOOKS) {
    return path.resolve(process.env.AGENT_REWIND_CODEX_HOOKS);
  }
  const codexHome = process.env.AGENT_REWIND_CODEX_HOME ?? process.env.CODEX_HOME;
  return path.join(codexHome ? path.resolve(codexHome) : path.join(homeDirectory, ".codex"), "hooks.json");
}

export function defaultCodexGuardScriptPath(homeDirectory = os.homedir()): string {
  if (process.env.AGENT_REWIND_CODEX_GUARD) {
    return path.resolve(process.env.AGENT_REWIND_CODEX_GUARD);
  }
  const dataDirectory = process.env.AGENT_REWIND_DATA_DIR
    ? path.resolve(process.env.AGENT_REWIND_DATA_DIR)
    : path.join(homeDirectory, ".agent-rewind");
  return path.join(dataDirectory, "hooks", "codex-guard.mjs");
}

export function codexGuardScriptSource(): string {
  return `// Managed by Agent Rewind. Shell commands remain outside this guard.
let source = "";
for await (const chunk of process.stdin) source += chunk;

const input = JSON.parse(source);
const blocked = new Set(["apply_patch", "Edit", "Write"]);
if (input.hook_event_name === "PreToolUse" && blocked.has(input.tool_name)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Blocked by Agent Rewind guard. Use the filesystem-with-rewind MCP write_file or edit_file tool instead.",
    },
  }));
}
`;
}

export async function installCodexGuard(
  options: { hooksFilename?: string; scriptFilename?: string; dryRun?: boolean } = {},
): Promise<GuardUpdateResult> {
  const hooksFilename = options.hooksFilename ?? defaultCodexHooksPath();
  const scriptFilename = options.scriptFilename ?? defaultCodexGuardScriptPath();
  const scriptSource = codexGuardScriptSource();
  const currentScript = await readOptional(scriptFilename);
  if (currentScript !== undefined && currentScript !== scriptSource) {
    throw new Error(`Refusing to overwrite a modified Codex guard script: ${scriptFilename}`);
  }

  const currentHooks = await readHooks(hooksFilename);
  const group = guardGroup(scriptFilename);
  const groups = preToolUseGroups(currentHooks.config);
  const hasGroup = groups.some((candidate) => JSON.stringify(candidate) === JSON.stringify(group));
  if (currentScript === scriptSource && hasGroup) {
    return {
      changed: false,
      files: [hooksFilename, scriptFilename],
      preview: { [hooksFilename]: currentHooks.source, [scriptFilename]: scriptSource },
    };
  }

  const hooksSource = hasGroup
    ? currentHooks.source
    : updatePreToolUse(currentHooks.source, [...groups, group]);
  if (!options.dryRun) {
    const createdScript = currentScript === undefined;
    try {
      if (createdScript) await persistConfigSource(scriptFilename, scriptSource, false, {});
      if (!hasGroup) {
        await persistConfigSource(hooksFilename, hooksSource, currentHooks.exists, {});
      }
    } catch (error) {
      if (createdScript) await rm(scriptFilename, { force: true });
      throw error;
    }
  }
  return {
    changed: true,
    files: [hooksFilename, scriptFilename],
    preview: { [hooksFilename]: hooksSource, [scriptFilename]: scriptSource },
  };
}

export async function uninstallCodexGuard(
  options: { hooksFilename?: string; scriptFilename?: string; dryRun?: boolean } = {},
): Promise<GuardUpdateResult> {
  const hooksFilename = options.hooksFilename ?? defaultCodexHooksPath();
  const scriptFilename = options.scriptFilename ?? defaultCodexGuardScriptPath();
  const scriptSource = codexGuardScriptSource();
  const currentScript = await readOptional(scriptFilename);
  if (currentScript !== undefined && currentScript !== scriptSource) {
    throw new Error(`Refusing to remove a modified Codex guard script: ${scriptFilename}`);
  }
  const currentHooks = await readHooks(hooksFilename);
  const group = guardGroup(scriptFilename);
  const groups = preToolUseGroups(currentHooks.config);
  const remaining = groups.filter(
    (candidate) => JSON.stringify(candidate) !== JSON.stringify(group),
  );
  const removedHook = remaining.length !== groups.length;
  const hooksSource = removedHook
    ? updatePreToolUse(currentHooks.source, remaining)
    : currentHooks.source;
  if (!options.dryRun) {
    if (removedHook) {
      await persistConfigSource(hooksFilename, hooksSource, currentHooks.exists, {});
    }
    if (currentScript === scriptSource) await rm(scriptFilename);
  }
  return {
    changed: removedHook || currentScript === scriptSource,
    files: [hooksFilename, scriptFilename],
    preview: removedHook ? { [hooksFilename]: hooksSource } : {},
  };
}

export async function inspectCodexGuard(
  options: { hooksFilename?: string; scriptFilename?: string } = {},
): Promise<GuardState> {
  const hooksFilename = options.hooksFilename ?? defaultCodexHooksPath();
  const scriptFilename = options.scriptFilename ?? defaultCodexGuardScriptPath();
  try {
    const [currentScript, currentHooks] = await Promise.all([
      readOptional(scriptFilename),
      readHooks(hooksFilename),
    ]);
    const hasGroup = preToolUseGroups(currentHooks.config).some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(guardGroup(scriptFilename)),
    );
    if (currentScript === undefined && !hasGroup) return "missing";
    return currentScript === codexGuardScriptSource() && hasGroup ? "configured" : "conflict";
  } catch {
    return "conflict";
  }
}

function guardGroup(scriptFilename: string): HookGroup {
  return {
    matcher: "^(apply_patch|Edit|Write)$",
    hooks: [
      {
        type: "command",
        command: `node ${shellQuote(scriptFilename)}`,
        timeout: 30,
        statusMessage: "Routing file edits through Agent Rewind",
      },
    ],
  };
}

async function readHooks(
  filename: string,
): Promise<{ source: string; config: Record<string, unknown>; exists: boolean }> {
  const source = await readOptional(filename);
  if (source === undefined) {
    const initial = `${JSON.stringify({ description: "Codex lifecycle hooks", hooks: {} }, null, 2)}\n`;
    return { source: initial, config: parseConfig(initial, filename), exists: false };
  }
  return { source, config: parseConfig(source, filename), exists: true };
}

function parseConfig(source: string, filename: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) {
    throw new Error(
      `Refusing to modify invalid Codex hooks at ${filename}: ${printParseErrorCode(errors[0].error)}`,
    );
  }
  if (!isObject(value)) throw new Error(`Refusing to modify non-object Codex hooks: ${filename}`);
  return value;
}

function preToolUseGroups(config: Record<string, unknown>): HookGroup[] {
  const hooks = config.hooks;
  if (hooks === undefined) return [];
  if (!isObject(hooks)) throw new Error("Codex hooks property must be an object");
  const groups = hooks.PreToolUse;
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error("Codex hooks.PreToolUse must be an array");
  return groups as HookGroup[];
}

function updatePreToolUse(source: string, groups: HookGroup[]): string {
  return applyEdits(
    source,
    modify(source, ["hooks", "PreToolUse"], groups, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptional(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
