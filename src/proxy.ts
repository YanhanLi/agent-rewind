import { randomUUID } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
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
import type { ChangeIntent, ChangeRecord, EntryState, PathChange } from "./model.js";
import type { Ledger } from "./ledger.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { OperationLock } from "./operation-lock.js";

const DELETE_FILE = "rewind_delete_file";
const DELETE_DIRECTORY = "rewind_delete_directory";
const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "move_file",
  DELETE_FILE,
  DELETE_DIRECTORY,
]);
const BEGIN_CHANGE_SET = "rewind_begin_change_set";
const END_CHANGE_SET = "rewind_end_change_set";

interface ProxyOptions {
  roots: string[];
  approval: ApprovalServer;
  snapshots: SnapshotStore;
  ledger: Ledger;
  operationLock: OperationLock;
  changeSetWindowMs: number;
}

export async function startProxy(options: ProxyOptions): Promise<() => Promise<void>> {
  const upstream = new Client({ name: "agent-rewind", version: "0.19.0" });
  const changeSets = new ChangeSetTracker(options.changeSetWindowMs);
  const mutationQueue = new SerialQueue();
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
    { name: "agent-rewind", version: "0.19.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await upstream.listTools();
    return {
      ...result,
      tools: [
        ...result.tools.map((tool) =>
          MUTATING_TOOLS.has(tool.name)
            ? {
                ...tool,
                description: `${tool.description ?? tool.name}\n\nAgent Rewind previews this operation and requires local approval before execution.`,
              }
            : tool,
        ),
        {
          name: DELETE_FILE,
          description:
            "Delete one file through Agent Rewind. The file is snapshotted, previewed, and requires local approval so it can be restored later. Directories are rejected.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", minLength: 1, description: "Absolute path to the file." },
            },
            required: ["path"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        },
        {
          name: DELETE_DIRECTORY,
          description:
            "Recursively delete one directory through Agent Rewind. Its files and empty directories are snapshotted, previewed, and require local approval. Configured root directories cannot be deleted.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: {
                type: "string",
                minLength: 1,
                description: "Absolute path to the directory.",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        },
        {
          name: BEGIN_CHANGE_SET,
          description:
            "Start a named Agent Rewind change set before a multi-step filesystem task. Subsequent filesystem mutations are grouped until rewind_end_change_set is called.",
          inputSchema: {
            type: "object" as const,
            properties: {
              label: {
                type: "string",
                maxLength: 120,
                description: "Short user-facing task name.",
              },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        {
          name: END_CHANGE_SET,
          description:
            "End the current Agent Rewind change set after a multi-step filesystem task is complete.",
          inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArguments } = request.params;
    const arguments_ = (rawArguments ?? {}) as Record<string, unknown>;
    if (name === BEGIN_CHANGE_SET) {
      try {
        const label = optionalLabel(arguments_.label);
        const replaced = changeSets.end();
        if (replaced) options.approval.endChangeSet(replaced);
        const id = changeSets.begin(label);
        return success(`Started change set ${id}${label ? `: ${label}` : ""}.`);
      } catch (error) {
        return failure((error as Error).message);
      }
    }
    if (name === END_CHANGE_SET) {
      const ended = changeSets.end();
      if (ended) options.approval.endChangeSet(ended);
      return success(ended ? `Ended change set ${ended}.` : "No change set was active.");
    }
    if (!MUTATING_TOOLS.has(name) || (name === "edit_file" && arguments_.dryRun === true)) {
      return upstream.callTool(request.params) as Promise<CallToolResult>;
    }

    try {
      const targets = await targetPaths(name, arguments_, options.roots);
      const before = await options.operationLock.run(() =>
        Promise.all(targets.map((target) => options.snapshots.capture(target))),
      );
      if (name === DELETE_FILE && before[0].kind !== "file") {
        throw new Error(
          before[0].kind === "directory"
            ? "rewind_delete_file only deletes files; directory deletion is not supported"
            : `Cannot delete a missing file: ${targets[0]}`,
        );
      }
      if (name === DELETE_DIRECTORY) {
        if (options.roots.some((root) => path.resolve(root) === targets[0])) {
          throw new Error("Refusing to delete a configured root directory");
        }
        if (before[0].kind !== "directory") {
          throw new Error(
            before[0].kind === "file"
              ? "rewind_delete_directory only deletes directories"
              : `Cannot delete a missing directory: ${targets[0]}`,
          );
        }
      }
      const detail = await preview(name, arguments_, before, upstream);
      const summary = summarize(name, targets, before, arguments_);
      const explicitChangeSet = changeSets.explicit();
      const approved = await options.approval.request({
        tool: name,
        summary,
        detail: withImpact(detail, before),
        arguments: arguments_,
        paths: targets,
        scope: commonParent(targets),
        changeSetId: explicitChangeSet?.id,
        changeSetLabel: explicitChangeSet?.label,
      });
      if (!approved) {
        return denied(name);
      }

      return await mutationQueue.run(() =>
        options.operationLock.run(async () => {
          // Serialize this second check with execution so concurrent approvals cannot
          // both validate the same old state and produce inconsistent undo records.
          const executionTargets = await targetPaths(name, arguments_, options.roots);
          const atExecution = await Promise.all(
            executionTargets.map((target) => options.snapshots.capture(target)),
          );
          if (atExecution.some((state, index) => state.hash !== before[index].hash)) {
            return failure("The target changed while approval was pending. Review and retry.");
          }

          const changeSet = explicitChangeSet ?? changeSets.next();
          const intent: ChangeIntent = {
            id: randomUUID(),
            changeSetId: changeSet.id,
            changeSetLabel: changeSet.label,
            tool: name,
            summary,
            createdAt: new Date().toISOString(),
            paths: targets.map((target, index) => ({ path: target, before: before[index] })),
          };
          options.ledger.beginIntent(intent);
          const testDelayMs = Number(process.env.AGENT_REWIND_TEST_DELAY_AFTER_INTENT_MS ?? 0);
          if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, testDelayMs));
          }

          let result: CallToolResult | undefined;
          let executionError: unknown;
          try {
            result =
              name === DELETE_FILE || name === DELETE_DIRECTORY
                ? await deleteTarget(name, targets[0])
                : ((await upstream.callTool(request.params)) as CallToolResult);
            if (process.env.AGENT_REWIND_TEST_CRASH_AFTER_MUTATION === "1") {
              process.kill(process.pid, "SIGKILL");
            }
          } catch (error) {
            executionError = error;
          }

          await settleIntent(intent, targets, before, options);
          if (executionError) throw executionError;
          return result!;
        }),
      );
    } catch (error) {
      return failure((error as Error).message);
    }
  });

  await server.connect(new StdioServerTransport());
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await mutationQueue.drain();
    await Promise.allSettled([server.close(), upstream.close()]);
  };
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

async function settleIntent(
  intent: ChangeIntent,
  targets: string[],
  before: EntryState[],
  options: Pick<ProxyOptions, "snapshots" | "ledger">,
): Promise<void> {
  const after = await Promise.all(targets.map((target) => options.snapshots.capture(target)));
  const paths: PathChange[] = targets.map((target, index) => ({
    path: target,
    before: before[index],
    after: after[index],
  }));
  if (!paths.some((item) => item.before.hash !== item.after.hash)) {
    options.ledger.discardIntent(intent.id);
    return;
  }
  const record: ChangeRecord = {
    id: intent.id,
    changeSetId: intent.changeSetId,
    changeSetLabel: intent.changeSetLabel,
    tool: intent.tool,
    summary: intent.summary,
    createdAt: intent.createdAt,
    status: "applied",
    paths,
  };
  options.ledger.finalizeIntent(intent.id, record);
  options.ledger.recordEvent({ type: "change_applied", tool: intent.tool });
}

class ChangeSetTracker {
  private current?: { id: string; label?: string; lastActivity: number; explicit: boolean };

  constructor(private readonly windowMs: number) {}

  begin(label?: string, now = Date.now()): string {
    this.current = { id: randomUUID(), label, lastActivity: now, explicit: true };
    return this.current.id;
  }

  end(): string | undefined {
    const id = this.current?.id;
    this.current = undefined;
    return id;
  }

  next(now = Date.now()): { id: string; label?: string } {
    if (!this.current || (!this.current.explicit && now - this.current.lastActivity > this.windowMs)) {
      this.current = { id: randomUUID(), lastActivity: now, explicit: false };
    } else {
      this.current.lastActivity = now;
    }
    return { id: this.current.id, label: this.current.label };
  }

  explicit(): { id: string; label?: string } | undefined {
    return this.current?.explicit ? { id: this.current.id, label: this.current.label } : undefined;
  }
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Expected label to be a string");
  const label = value.trim();
  if (label.length === 0) return undefined;
  if (label.length > 120) throw new Error("Change-set label must be at most 120 characters");
  return label;
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
  if (name === DELETE_FILE) {
    return `Delete file:\n${String(args.path)}\n\nThe captured snapshot can be restored unless the path is recreated before undo.`;
  }
  if (name === DELETE_DIRECTORY) {
    const stats = directoryStats(before[0]);
    const topLevel =
      before[0].kind === "directory" && before[0].children
        ? Object.keys(before[0].children).slice(0, 20)
        : [];
    return `Delete directory recursively:\n${String(args.path)}\n\nContains ${stats.files} file${stats.files === 1 ? "" : "s"} and ${stats.directories} subdirector${stats.directories === 1 ? "y" : "ies"}.\nTop-level entries:\n${topLevel.map((name) => `- ${name}`).join("\n") || "(empty)"}`;
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
  if (name === DELETE_FILE) return `Delete ${targets[0]}`;
  if (name === DELETE_DIRECTORY) return `Delete directory ${targets[0]}`;
  return `Create directory ${targets[0]}`;
}

async function deleteTarget(name: string, target: string): Promise<CallToolResult> {
  await rm(target, { recursive: name === DELETE_DIRECTORY });
  return success(`Deleted ${target}. Agent Rewind recorded a restorable snapshot.`);
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
    (total, state) => total + entryBytes(state),
    0,
  );
  const limit = 100_000;
  const preview = detail.length > limit ? `${detail.slice(0, limit)}\n\n[Preview truncated]` : detail;
  return `Affected paths: ${before.length}\nSnapshot size: ${formatBytes(snapshotBytes)}\n\n${preview}`;
}

function entryBytes(state: EntryState): number {
  if (state.kind === "file") return state.size;
  if (state.kind !== "directory" || !state.children) return 0;
  return Object.values(state.children).reduce((total, child) => total + entryBytes(child), 0);
}

function directoryStats(state: EntryState): { files: number; directories: number } {
  if (state.kind !== "directory" || !state.children) return { files: 0, directories: 0 };
  return Object.values(state.children).reduce(
    (total, child) => {
      if (child.kind === "file") total.files += 1;
      if (child.kind === "directory") {
        total.directories += 1;
        const nested = directoryStats(child);
        total.files += nested.files;
        total.directories += nested.directories;
      }
      return total;
    },
    { files: 0, directories: 0 },
  );
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

function success(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}
