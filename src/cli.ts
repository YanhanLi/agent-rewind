#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ApprovalServer } from "./approval-server.js";
import { Ledger } from "./ledger.js";
import { startProxy } from "./proxy.js";
import { RewindService } from "./rewind-service.js";
import { SnapshotStore } from "./snapshot-store.js";

async function main(): Promise<void> {
  if (process.argv[2] === "doctor") {
    await doctor(process.argv.slice(3));
    return;
  }
  const parsed = parseArguments(process.argv.slice(2));
  const dataDirectory = process.env.AGENT_REWIND_DATA_DIR
    ? path.resolve(process.env.AGENT_REWIND_DATA_DIR)
    : path.join(os.homedir(), ".agent-rewind");
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
        "Usage: agent-rewind [--port 3219] <allowed-directory> [...]\n       agent-rewind doctor <allowed-directory> [...]\n",
      );
      process.exit(0);
    } else {
      roots.push(path.resolve(args[index]));
    }
  }
  if (roots.length === 0) throw new Error("Provide at least one allowed directory.");
  return { roots: [...new Set(roots)], port };
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

async function doctor(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error("doctor requires at least one allowed directory");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
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

  const dataDirectory = process.env.AGENT_REWIND_DATA_DIR
    ? path.resolve(process.env.AGENT_REWIND_DATA_DIR)
    : path.join(os.homedir(), ".agent-rewind");
  try {
    await mkdir(dataDirectory, { recursive: true });
    await access(dataDirectory, constants.R_OK | constants.W_OK);
    checks.push({ name: "Data directory", ok: true, detail: dataDirectory });
  } catch {
    checks.push({ name: "Data directory", ok: false, detail: `${dataDirectory} is not writable` });
  }

  process.stdout.write(
    `${checks.map((check) => `${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`).join("\n")}\n`,
  );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`agent-rewind: ${(error as Error).message}\n`);
  process.exit(1);
});
