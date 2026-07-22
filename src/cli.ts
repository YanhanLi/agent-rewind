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
import { Ledger } from "./ledger.js";
import type { ValidationReport } from "./model.js";
import { startProxy } from "./proxy.js";
import { RewindService } from "./rewind-service.js";
import { SnapshotStore } from "./snapshot-store.js";

async function main(): Promise<void> {
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    process.stdout.write("agent-rewind 0.6.0\n");
    return;
  }
  if (process.argv[2] === "report") {
    await report(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "doctor") {
    await doctor(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "config" && process.argv[3] === "claude") {
    printClaudeConfig(process.argv.slice(4));
    return;
  }
  if (process.argv[2] === "install" && process.argv[3] === "claude") {
    await installClaude(process.argv.slice(4));
    return;
  }
  if (process.argv[2] === "uninstall" && process.argv[3] === "claude") {
    await uninstallClaude(process.argv.slice(4));
    return;
  }
  const parsed = parseArguments(process.argv.slice(2));
  const dataDirectory = getDataDirectory();
  await mkdir(dataDirectory, { recursive: true });
  const snapshots = new SnapshotStore(path.join(dataDirectory, "blobs"), {
    maxFileBytes: megabytesFromEnvironment("AGENT_REWIND_MAX_FILE_MB", 16),
    maxTotalBytes: megabytesFromEnvironment("AGENT_REWIND_MAX_TOTAL_MB", 1024),
  });
  await snapshots.initialize();
  const ledger = new Ledger(path.join(dataDirectory, "ledger.sqlite"));
  const retentionDays = positiveNumberFromEnvironment("AGENT_REWIND_RETENTION_DAYS", 7);
  ledger.pruneBefore(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));
  await snapshots.garbageCollect(ledger.referencedBlobs());
  const rewind = new RewindService(ledger, snapshots);
  const approval = new ApprovalServer(
    rewind,
    parsed.port,
    millisecondsFromEnvironment("AGENT_REWIND_APPROVAL_TIMEOUT_MS", 120_000),
  );
  await approval.start();
  await startProxy({
    roots: parsed.roots,
    approval,
    snapshots,
    ledger,
    changeSetWindowMs: millisecondsFromEnvironment("AGENT_REWIND_CHANGE_SET_WINDOW_MS", 30_000),
  });
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
        "Usage: agent-rewind [--port 3219] <allowed-directory> [...]\n       agent-rewind doctor <allowed-directory> [...]\n       agent-rewind report [--json]\n       agent-rewind config claude <allowed-directory> [...]\n       agent-rewind install claude [--dry-run] <allowed-directory> [...]\n       agent-rewind uninstall claude [--dry-run]\n       agent-rewind --version\n",
      );
      process.exit(0);
    } else {
      roots.push(path.resolve(args[index]));
    }
  }
  if (roots.length === 0) throw new Error("Provide at least one allowed directory.");
  return { roots: [...new Set(roots)], port };
}

function printClaudeConfig(args: string[]): void {
  if (args.length === 0) throw new Error("config claude requires at least one allowed directory");
  const roots = [...new Set(args.map((value) => path.resolve(value)))];
  process.stdout.write(`${JSON.stringify(buildClaudeConfigFragment(roots), null, 2)}\n`);
}

async function installClaude(args: string[]): Promise<void> {
  const { dryRun, values } = parseDryRun(args);
  const roots = [...new Set(values.map((value) => path.resolve(value)))];
  for (const root of roots) {
    try {
      await access(root, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`Allowed directory is not readable/writable: ${root}`);
    }
  }
  const result = await installClaudeConfig(roots, { dryRun });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
    return;
  }
  if (!result.changed) {
    process.stdout.write(`Claude Desktop is already configured: ${result.filename}\n`);
    return;
  }
  process.stdout.write(`Updated Claude Desktop configuration: ${result.filename}\n`);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  process.stdout.write("Restart Claude Desktop to apply the change.\n");
}

async function uninstallClaude(args: string[]): Promise<void> {
  const { dryRun, values } = parseDryRun(args);
  if (values.length > 0) throw new Error("uninstall claude accepts only --dry-run");
  const result = await uninstallClaudeConfig({ dryRun });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
    return;
  }
  if (!result.changed) {
    process.stdout.write(`Agent Rewind is not configured in: ${result.filename}\n`);
    return;
  }
  process.stdout.write(`Removed Agent Rewind from: ${result.filename}\n`);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  process.stdout.write("Restart Claude Desktop to apply the change.\n");
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
  const result = new Ledger(path.join(dataDirectory, "ledger.sqlite")).validationReport();
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
    `Approvals: ${report.approvals.requested} requested, ${report.approvals.approved} approved, ${report.approvals.sessionApproved} folder-approved, ${report.approvals.autoApproved} auto-approved, ${report.approvals.rejected} rejected, ${report.approvals.expired} expired`,
    `Changes: ${report.changes.actions} actions in ${report.changes.changeSets} sets; ${report.changes.applied} applied, ${report.changes.undone} undone, ${report.changes.conflicts} conflicts`,
    `Undo: ${report.undo.attempted} attempted, ${report.undo.succeeded} succeeded, ${report.undo.conflicts} conflicts`,
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

  process.stdout.write(
    `${checks.map((check) => `${!check.ok ? "FAIL" : check.warning ? "WARN" : "PASS"}  ${check.name}: ${check.detail}`).join("\n")}\n`,
  );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`agent-rewind: ${(error as Error).message}\n`);
  process.exit(1);
});
