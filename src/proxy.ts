import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createTwoFilesPatch } from "diff";
import type { ApprovalServer } from "./approval-server.js";
import type { ChangeRecord, EntryState, PathChange } from "./model.js";
import type { Ledger } from "./ledger.js";
import type { SnapshotStore } from "./snapshot-store.js";

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "create_directory", "move_file"]);

interface ProxyOptions {
  roots: string[];
  approval: ApprovalServer;
  snapshots: SnapshotStore;
  ledger: Ledger;
  changeSetWindowMs: number;
}

export async function startProxy(options: ProxyOptions): Promise<void> {
  const upstream = new Client({ name: "agent-rewind", version: "0.3.0" });
  const changeSets = new ChangeSetTracker(options.changeSetWindowMs);
  const require = createRequire(import.meta.url);
  const filesystemPackage = require.resolve("@modelcontextprotocol/server-filesystem/package.json");
  const filesystemEntry = path.join(path.dirname(filesystemPackage), "dist", "index.js");
  const upstreamTransport = new StdioClientTransport({
    command: process.execPath,
    args: [filesystemEntry, ...options.roots],
    stderr: "inherit",
  });
  await upstream.connect(upstreamTransport);

  const server = new Server(
    { name: "agent-rewind", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await upstream.listTools();
    return {
      ...result,
      tools: result.tools.map((tool) =>
        MUTATING_TOOLS.has(tool.name)
          ? {
              ...tool,
              description: `${tool.description ?? tool.name}\n\nAgent Rewind previews this operation and requires local approval before execution.`,
            }
          : tool,
      ),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArguments } = request.params;
    const arguments_ = (rawArguments ?? {}) as Record<string, unknown>;
    if (!MUTATING_TOOLS.has(name) || (name === "edit_file" && arguments_.dryRun === true)) {
      return upstream.callTool(request.params) as Promise<CallToolResult>;
    }

    try {
      const targets = await targetPaths(name, arguments_, options.roots);
      const before = await Promise.all(targets.map((target) => options.snapshots.capture(target)));
      const detail = await preview(name, arguments_, before, upstream);
      const summary = summarize(name, targets, before, arguments_);
      const approved = await options.approval.request({
        tool: name,
        summary,
        detail: withImpact(detail, before),
        arguments: arguments_,
        paths: targets,
        scope: commonParent(targets),
      });
      if (!approved) {
        return denied(name);
      }

      // Close the time-of-check/time-of-use gap while the approval page was open.
      const atExecution = await Promise.all(
        targets.map((target) => options.snapshots.capture(target)),
      );
      if (atExecution.some((state, index) => state.hash !== before[index].hash)) {
        return failure("The target changed while approval was pending. Review and retry.");
      }

      const result = (await upstream.callTool(request.params)) as CallToolResult;
      if (result.isError) return result;
      const after = await Promise.all(targets.map((target) => options.snapshots.capture(target)));
      const paths: PathChange[] = targets.map((target, index) => ({
        path: target,
        before: before[index],
        after: after[index],
      }));
      if (paths.some((item) => item.before.hash !== item.after.hash)) {
        const record: ChangeRecord = {
          id: randomUUID(),
          changeSetId: changeSets.next(),
          tool: name,
          summary,
          createdAt: new Date().toISOString(),
          status: "applied",
          paths,
        };
        options.ledger.add(record);
      }
      return result;
    } catch (error) {
      return failure((error as Error).message);
    }
  });

  await server.connect(new StdioServerTransport());
}

class ChangeSetTracker {
  private current?: { id: string; lastActivity: number };

  constructor(private readonly windowMs: number) {}

  next(now = Date.now()): string {
    if (!this.current || now - this.current.lastActivity > this.windowMs) {
      this.current = { id: randomUUID(), lastActivity: now };
    } else {
      this.current.lastActivity = now;
    }
    return this.current.id;
  }
}

async function targetPaths(
  name: string,
  args: Record<string, unknown>,
  roots: string[],
): Promise<string[]> {
  const values =
    name === "move_file"
      ? [requiredString(args.source, "source"), requiredString(args.destination, "destination")]
      : [requiredString(args.path, "path")];
  return Promise.all(values.map((value) => withinRoots(value, roots)));
}

async function withinRoots(value: string, roots: string[]): Promise<string> {
  const target = path.resolve(value);
  const lexicallyAllowed = roots.some((root) => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!lexicallyAllowed) throw new Error(`Path is outside the configured roots: ${target}`);

  const [resolvedTarget, resolvedRoots] = await Promise.all([
    resolveThroughExistingAncestor(target),
    Promise.all(roots.map((root) => realpath(root))),
  ]);
  const canonicallyAllowed = resolvedRoots.some((root) => {
    const relative = path.relative(root, resolvedTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!canonicallyAllowed) {
    throw new Error(`Path resolves outside the configured roots: ${target}`);
  }
  return target;
}

async function resolveThroughExistingAncestor(target: string): Promise<string> {
  let existing = target;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return path.join(await realpath(existing), path.relative(existing, target));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected a non-empty ${field}`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${field} to be a string`);
  return value;
}

async function preview(
  name: string,
  args: Record<string, unknown>,
  before: EntryState[],
  upstream: Client,
): Promise<string> {
  if (name === "write_file") {
    const content = stringValue(args.content, "content");
    let previous = "";
    if (before[0].kind === "file") {
      const read = (await upstream.callTool({
        name: "read_text_file",
        arguments: { path: args.path },
      })) as CallToolResult;
      const block = read.content.find((item) => item.type === "text");
      previous = block?.type === "text" ? block.text : "";
    }
    return createTwoFilesPatch(String(args.path), String(args.path), previous, content, "before", "after");
  }
  if (name === "edit_file") {
    const dryRun = (await upstream.callTool({
      name: "edit_file",
      arguments: { ...args, dryRun: true },
    })) as CallToolResult;
    return dryRun.content
      .filter((item) => item.type === "text")
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n");
  }
  if (name === "move_file") {
    return `Move or rename:\n${String(args.source)}\n→ ${String(args.destination)}`;
  }
  return `Create directory, including missing parents:\n${String(args.path)}`;
}

function summarize(
  name: string,
  targets: string[],
  before: EntryState[],
  args: Record<string, unknown>,
): string {
  if (name === "write_file") {
    return `${before[0].kind === "missing" ? "Create" : "Overwrite"} ${targets[0]}`;
  }
  if (name === "edit_file") {
    const count = Array.isArray(args.edits) ? args.edits.length : 0;
    return `Apply ${count} edit${count === 1 ? "" : "s"} to ${targets[0]}`;
  }
  if (name === "move_file") return `Move ${targets[0]} to ${targets[1]}`;
  return `Create directory ${targets[0]}`;
}

function commonParent(targets: string[]): string {
  const directories = targets.map((target) => path.dirname(target));
  let candidate = directories[0];
  while (
    !directories.every((directory) => {
      const relative = path.relative(candidate, directory);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
  ) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function withImpact(detail: string, before: EntryState[]): string {
  const snapshotBytes = before.reduce(
    (total, state) => total + (state.kind === "file" ? state.size : 0),
    0,
  );
  const limit = 100_000;
  const preview = detail.length > limit ? `${detail.slice(0, limit)}\n\n[Preview truncated]` : detail;
  return `Affected paths: ${before.length}\nSnapshot size: ${formatBytes(snapshotBytes)}\n\n${preview}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function denied(name: string): CallToolResult {
  return failure(`${name} was rejected in Agent Rewind.`);
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
