#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ApprovalServer } from "./approval-server.js";
import {
  buildClaudeConfigFragment,
  defaultClaudeConfigPath,
  inspectClaudeConfig,
  installClaudeConfig,
  uninstallClaudeConfig,
} from "./claude-config.js";
import {
  buildCodexConfigFragment,
  defaultCodexConfigPath,
  inspectCodexConfig,
  installCodexConfig,
  uninstallCodexConfig,
} from "./codex-config.js";
import {
  inspectCodexGuard,
  installCodexGuard,
  uninstallCodexGuard,
} from "./codex-guard.js";
import { runDemo } from "./demo.js";
import { Ledger } from "./ledger.js";
import { SqliteOperationLock } from "./operation-lock.js";
import type { ValidationReport } from "./model.js";
import {
  buildOpenCodeConfigFragment,
  defaultOpenCodeConfigPath,
  inspectOpenCodeConfig,
  installOpenCodeConfig,
  uninstallOpenCodeConfig,
} from "./opencode-config.js";
import {
  inspectOpenCodeGuard,
  installOpenCodeGuard,
  uninstallOpenCodeGuard,
} from "./opencode-guard.js";
import { startProxy } from "./proxy.js";
import { RewindService } from "./rewind-service.js";
import { SnapshotStore } from "./snapshot-store.js";

async function main(): Promise<void> {
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    process.stdout.write("agent-rewind 0.22.1\n");
    return;
  }
  if (process.argv[2] === "report") {
    await report(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "demo") {
    await runDemo(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "doctor") {
    await doctor(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "config") {
    printClientConfig(process.argv[3], process.argv.slice(4));
    return;
  }
  if (process.argv[2] === "install") {
    await installClient(process.argv[3], process.argv.slice(4));
    return;
  }
  if (process.argv[2] === "uninstall") {
    await uninstallClient(process.argv[3], process.argv.slice(4));
    return;
  }
  if (process.argv[2] === "guard" || process.argv[2] === "unguard") {
    await updateGuard(process.argv[2], process.argv[3], process.argv.slice(4));
    return;
  }
  const parsed = parseArguments(process.argv.slice(2));
  const dataDirectory = getDataDirectory();
  await mkdir(dataDirectory, { recursive: true });
  const operationLock = new SqliteOperationLock(path.join(dataDirectory, "operation-lock.sqlite"));
  const snapshots = new SnapshotStore(path.join(dataDirectory, "blobs"), {
    maxFileBytes: megabytesFromEnvironment("AGENT_REWIND_MAX_FILE_MB", 16),
    maxTotalBytes: megabytesFromEnvironment("AGENT_REWIND_MAX_TOTAL_MB", 1024),
  });
  const retentionDays = positiveNumberFromEnvironment("AGENT_REWIND_RETENTION_DAYS", 7);
  const ledger = await operationLock.run(async () => {
    await snapshots.initialize();
    const result = new Ledger(path.join(dataDirectory, "ledger.sqlite"));
    result.pruneBefore(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));
    return result;
  });
  const rewind = new RewindService(ledger, snapshots, operationLock);
  const recovery = await rewind.recoverIntents();
  const approvalTimeoutMs = millisecondsFromEnvironment("AGENT_REWIND_APPROVAL_TIMEOUT_MS", 120_000);
  await operationLock.run(() =>
    snapshots.garbageCollect(ledger.referencedBlobs(), approvalTimeoutMs + 60_000),
  );
  if (recovery.recovered > 0 || recovery.discarded > 0 || recovery.pending > 0) {
    process.stderr.write(
      `Agent Rewind recovery: ${recovery.recovered} recovered, ${recovery.discarded} unchanged, ${recovery.pending} pending.\n`,
    );
  }
  const approval = new ApprovalServer(
    rewind,
    parsed.port,
    approvalTimeoutMs,
  );
  const shutdown = shutdownSignal();
  let closeProxy: (() => Promise<void>) | undefined;
  try {
    await approval.start();
    closeProxy = await startProxy({
      roots: parsed.roots,
      approval,
      snapshots,
      ledger,
      operationLock,
      changeSetWindowMs: millisecondsFromEnvironment("AGENT_REWIND_CHANGE_SET_WINDOW_MS", 30_000),
    });
    await shutdown.wait;
  } finally {
    shutdown.cancel();
    try {
      await approval.stop();
    } finally {
      try {
        await closeProxy?.();
      } finally {
        ledger.close();
      }
    }
  }
}

function shutdownSignal(): { wait: Promise<void>; cancel: () => void } {
  let resolve!: () => void;
  const wait = new Promise<void>((done) => {
    resolve = done;
  });
  const finish = () => {
    cancel();
    resolve();
  };
  const cancel = () => {
    process.stdin.off("end", finish);
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
  };
  process.stdin.once("end", finish);
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  if (process.stdin.readableEnded) finish();
  return { wait, cancel };
}

function parseArguments(args: string[]): { roots: string[]; port: number } {
  let port = 3219;
  const roots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--port") {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
    } else if (args[index] === "--help" || args[index] === "-h") {
      process.stderr.write(
        "Usage: agent-rewind [--port 3219] <allowed-directory> [...]\n       agent-rewind demo [--auto]\n       agent-rewind doctor <allowed-directory> [...]\n       agent-rewind report [--json]\n       agent-rewind config <claude|opencode|codex> <allowed-directory> [...]\n       agent-rewind install <claude|opencode|codex> [--dry-run] <allowed-directory> [...]\n       agent-rewind uninstall <claude|opencode|codex> [--dry-run]\n       agent-rewind guard <opencode|codex> [--dry-run]\n       agent-rewind unguard <opencode|codex> [--dry-run]\n       agent-rewind --version\n",
      );
      process.exit(0);
    } else {
      roots.push(path.resolve(args[index]));
    }
  }
  if (roots.length === 0) throw new Error("Provide at least one allowed directory.");
  return { roots: [...new Set(roots)], port };
}

function printClientConfig(client: string | undefined, args: string[]): void {
  if (!isClient(client)) throw new Error("config requires claude, opencode, or codex");
  if (args.length === 0) throw new Error(`config ${client} requires at least one allowed directory`);
  const roots = [...new Set(args.map((value) => path.resolve(value)))];
  if (client === "codex") {
    process.stdout.write(buildCodexConfigFragment(roots));
    return;
  }
  const config =
    client === "claude" ? buildClaudeConfigFragment(roots) : buildOpenCodeConfigFragment(roots);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function installClient(client: string | undefined, args: string[]): Promise<void> {
  if (!isClient(client)) throw new Error("install requires claude, opencode, or codex");
  const { dryRun, values } = parseDryRun(args);
  if (values.length === 0) throw new Error(`install ${client} requires at least one allowed directory`);
  const roots = [...new Set(values.map((value) => path.resolve(value)))];
  for (const root of roots) {
    try {
      await access(root, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`Allowed directory is not readable/writable: ${root}`);
    }
  }
  const result =
    client === "claude"
      ? await installClaudeConfig(roots, { dryRun })
      : client === "opencode"
        ? await installOpenCodeConfig(roots, { dryRun })
        : await installCodexConfig(roots, { dryRun });
  if (dryRun) {
    process.stdout.write(
      client === "codex"
        ? buildCodexConfigFragment(roots)
        : `${JSON.stringify(result.config, null, 2)}\n`,
    );
    return;
  }
  if (!result.changed) {
    process.stdout.write(`${clientLabel(client)} is already configured: ${result.filename}\n`);
    return;
  }
  process.stdout.write(`Updated ${clientLabel(client)} configuration: ${result.filename}\n`);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  process.stdout.write(`Restart ${clientLabel(client)} to apply the change.\n`);
}

async function uninstallClient(client: string | undefined, args: string[]): Promise<void> {
  if (!isClient(client)) throw new Error("uninstall requires claude, opencode, or codex");
  const { dryRun, values } = parseDryRun(args);
  if (values.length > 0) throw new Error(`uninstall ${client} accepts only --dry-run`);
  const result =
    client === "claude"
      ? await uninstallClaudeConfig({ dryRun })
      : client === "opencode"
        ? await uninstallOpenCodeConfig({ dryRun })
        : await uninstallCodexConfig({ dryRun });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
    return;
  }
  if (!result.changed) {
    process.stdout.write(`Agent Rewind is not configured for ${clientLabel(client)}: ${result.filename}\n`);
    return;
  }
  process.stdout.write(`Removed Agent Rewind from ${clientLabel(client)}: ${result.filename}\n`);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  process.stdout.write(`Restart ${clientLabel(client)} to apply the change.\n`);
}

type ClientName = "claude" | "opencode" | "codex";

function isClient(value: string | undefined): value is ClientName {
  return value === "claude" || value === "opencode" || value === "codex";
}

function clientLabel(client: ClientName): string {
  return client === "claude" ? "Claude Desktop" : client === "opencode" ? "OpenCode" : "Codex";
}

async function updateGuard(
  action: "guard" | "unguard",
  client: string | undefined,
  args: string[],
): Promise<void> {
  if (client !== "opencode" && client !== "codex") {
    throw new Error(`${action} requires opencode or codex`);
  }
  const { dryRun, values } = parseDryRun(args);
  if (values.length > 0) throw new Error(`${action} ${client} accepts only --dry-run`);
  const result =
    action === "guard"
      ? client === "opencode"
        ? await installOpenCodeGuard({ dryRun })
        : await installCodexGuard({ dryRun })
      : client === "opencode"
        ? await uninstallOpenCodeGuard({ dryRun })
        : await uninstallCodexGuard({ dryRun });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(result.preview, null, 2)}\n`);
    return;
  }
  if (!result.changed) {
    process.stdout.write(`${clientLabel(client)} guard is already ${action === "guard" ? "installed" : "absent"}.\n`);
    return;
  }
  process.stdout.write(
    `${action === "guard" ? "Installed" : "Removed"} ${clientLabel(client)} guard:\n${result.files.map((file) => `  ${file}`).join("\n")}\n`,
  );
  if (action === "guard" && client === "codex") {
    process.stdout.write("Open /hooks in Codex and trust the Agent Rewind hook before using it.\n");
  }
  process.stdout.write(`Restart ${clientLabel(client)} to apply the change.\n`);
}

function parseDryRun(args: string[]): { dryRun: boolean; values: string[] } {
  const unknown = args.filter((value) => value.startsWith("-") && value !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  return { dryRun: args.includes("--dry-run"), values: args.filter((value) => value !== "--dry-run") };
}

function megabytesFromEnvironment(name: string, fallback: number): number {
  const value = positiveNumberFromEnvironment(name, fallback);
  return Math.floor(value * 1024 * 1024);
}

function positiveNumberFromEnvironment(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function millisecondsFromEnvironment(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1_000) {
    throw new Error(`${name} must be an integer of at least 1000`);
  }
  return value;
}

function getDataDirectory(): string {
  return process.env.AGENT_REWIND_DATA_DIR
    ? path.resolve(process.env.AGENT_REWIND_DATA_DIR)
    : path.join(os.homedir(), ".agent-rewind");
}

async function report(args: string[]): Promise<void> {
  if (args.some((value) => value !== "--json")) {
    throw new Error("report accepts only --json");
  }
  const dataDirectory = getDataDirectory();
  await mkdir(dataDirectory, { recursive: true });
  const ledger = new Ledger(path.join(dataDirectory, "ledger.sqlite"));
  const result = ledger.validationReport();
  ledger.close();
  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result),
  );
}

function formatReport(report: ValidationReport): string {
  const period = report.period.firstEventAt
    ? `${report.period.firstEventAt} to ${report.period.lastEventAt}`
    : "no events recorded";
  const tools = Object.entries(report.tools)
    .map(([tool, count]) => `${tool}=${count}`)
    .join(", ");
  return [
    "Agent Rewind local validation report",
    `Period: ${period}`,
    `Approvals: ${report.approvals.requested} requested, ${report.approvals.approved} approved, ${report.approvals.changeSetApproved} set-approved, ${report.approvals.sessionApproved} folder-approved, ${report.approvals.autoApproved} auto-approved, ${report.approvals.rejected} rejected, ${report.approvals.expired} expired`,
    `Changes: ${report.changes.actions} actions in ${report.changes.changeSets} sets; ${report.changes.applied} applied, ${report.changes.undone} undone, ${report.changes.conflicts} conflicts`,
    `Undo: ${report.undo.attempted} attempted, ${report.undo.succeeded} succeeded, ${report.undo.conflicts} conflicts`,
    `Recovery: ${report.recovery.recovered} recovered, ${report.recovery.reviewed} reviewed, ${report.recovery.discarded} unchanged intents discarded`,
    `Tools: ${tools || "none"}`,
    "Privacy: local aggregate only; event rows contain no paths, file contents, prompts, or arguments.",
    "",
  ].join("\n");
}

async function doctor(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error("doctor requires at least one allowed directory");
  const checks: Array<{ name: string; ok: boolean; warning?: boolean; detail: string }> = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "Node.js",
    ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5),
    detail: `${process.versions.node} (requires 22.5 or newer)`,
  });

  const require = createRequire(import.meta.url);
  try {
    require.resolve("@modelcontextprotocol/server-filesystem/package.json");
    checks.push({ name: "Filesystem MCP", ok: true, detail: "installed" });
  } catch {
    checks.push({ name: "Filesystem MCP", ok: false, detail: "dependency not found" });
  }

  for (const value of args) {
    const target = path.resolve(value);
    try {
      await access(target, constants.R_OK | constants.W_OK);
      checks.push({ name: "Allowed directory", ok: true, detail: await realpath(target) });
    } catch {
      checks.push({ name: "Allowed directory", ok: false, detail: `${target} is not readable/writable` });
    }
  }

  const dataDirectory = getDataDirectory();
  try {
    await mkdir(dataDirectory, { recursive: true });
    await access(dataDirectory, constants.R_OK | constants.W_OK);
    checks.push({ name: "Data directory", ok: true, detail: dataDirectory });
  } catch {
    checks.push({ name: "Data directory", ok: false, detail: `${dataDirectory} is not writable` });
  }

  const claudeFilename = defaultClaudeConfigPath();
  const claudeState = await inspectClaudeConfig(claudeFilename);
  checks.push({
    name: "Claude Desktop",
    ok: claudeState !== "invalid",
    warning: claudeState === "missing",
    detail:
      claudeState === "configured"
        ? `configured in ${claudeFilename}`
        : claudeState === "missing"
          ? `not configured in ${claudeFilename}`
          : `invalid configuration at ${claudeFilename}`,
  });

  const openCodeFilename = defaultOpenCodeConfigPath();
  const openCodeState = await inspectOpenCodeConfig(openCodeFilename);
  checks.push({
    name: "OpenCode",
    ok: openCodeState !== "invalid",
    warning: openCodeState === "missing",
    detail:
      openCodeState === "configured"
        ? `configured in ${openCodeFilename}`
        : openCodeState === "missing"
          ? `not configured in ${openCodeFilename}`
          : `invalid configuration at ${openCodeFilename}`,
  });
  if (openCodeState === "configured") {
    const guard = await inspectOpenCodeGuard();
    checks.push({
      name: "OpenCode guard",
      ok: guard !== "conflict",
      warning: guard === "missing",
      detail:
        guard === "configured"
          ? "blocks built-in edit/write/apply_patch"
          : guard === "missing"
            ? "not installed; built-in edits can bypass Agent Rewind"
            : "managed plugin path contains unexpected content",
    });
  }

  const codexFilename = defaultCodexConfigPath();
  const codexState = await inspectCodexConfig();
  checks.push({
    name: "Codex",
    ok: codexState !== "invalid",
    warning: codexState === "missing" || codexState === "unavailable",
    detail:
      codexState === "configured"
        ? `configured in ${codexFilename}`
        : codexState === "missing"
          ? `not configured in ${codexFilename}`
          : codexState === "unavailable"
            ? "CLI not found"
            : `could not inspect configuration at ${codexFilename}`,
  });
  if (codexState === "configured") {
    const guard = await inspectCodexGuard();
    checks.push({
      name: "Codex guard",
      ok: guard !== "conflict",
      warning: guard === "missing",
      detail:
        guard === "configured"
          ? "blocks built-in apply_patch after hook trust"
          : guard === "missing"
            ? "not installed; built-in apply_patch can bypass Agent Rewind"
            : "hook configuration or script does not match Agent Rewind",
    });
  }
  checks.push({
    name: "Client bypass boundary",
    ok: true,
    warning: true,
    detail: "guard mode covers direct edit tools; shell writes remain outside this MCP proxy",
  });

  process.stdout.write(
    `${checks.map((check) => `${!check.ok ? "FAIL" : check.warning ? "WARN" : "PASS"}  ${check.name}: ${check.detail}`).join("\n")}\n`,
  );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`agent-rewind: ${(error as Error).message}\n`);
  process.exit(1);
});
