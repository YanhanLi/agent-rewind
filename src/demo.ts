import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface DemoState {
  pending: Array<{ id: string }>;
  changeSets: Array<{ id: string; label?: string }>;
}

export async function runDemo(args: string[]): Promise<void> {
  const automatic = args.includes("--auto");
  const unknown = args.filter((value) => value !== "--auto");
  if (unknown.length > 0) throw new Error(`Unknown demo option: ${unknown[0]}`);

  const parent = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-demo-"));
  const workspace = path.join(parent, "workspace");
  const dataDirectory = path.join(parent, "data");
  const token = randomBytes(24).toString("base64url");
  const port = await availablePort();
  await seedWorkspace(workspace);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "--port", String(port), workspace],
    env: {
      ...process.env,
      AGENT_REWIND_DATA_DIR: dataDirectory,
      AGENT_REWIND_TOKEN: token,
      ...(automatic ? { AGENT_REWIND_NO_BROWSER: "1" } : {}),
    } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "agent-rewind-demo", version: "1.0.0" });
  let interrupted = false;
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = () => {
    interrupted = true;
    resolveSignal();
    void transport.close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  process.stdout.write(`Demo workspace: ${workspace}\n`);
  process.stdout.write(
    automatic
      ? "Running automated approval, mutation, and undo verification.\n"
      : "The local approval page will open. Choose Allow set on the first action to run the full scenario with one confirmation.\n",
  );

  try {
    await client.connect(transport);
    await ensureSuccess(
      client.callTool({
        name: "rewind_begin_change_set",
        arguments: { label: "Organize project notes" },
      }),
    );

    const autoApproval = automatic ? approveNext(port, token, "approve-set") : undefined;
    await ensureSuccess(
      client.callTool({
        name: "write_file",
        arguments: {
          path: path.join(workspace, "index.md"),
          content: "# Project notes\n\n- [Final notes](notes/final.md)\n",
        },
      }),
    );
    await autoApproval;
    await ensureSuccess(
      client.callTool({
        name: "move_file",
        arguments: {
          source: path.join(workspace, "notes", "draft.md"),
          destination: path.join(workspace, "notes", "final.md"),
        },
      }),
    );
    await ensureSuccess(
      client.callTool({
        name: "rewind_delete_directory",
        arguments: { path: path.join(workspace, "archive") },
      }),
    );
    await ensureSuccess(client.callTool({ name: "rewind_end_change_set", arguments: {} }));

    process.stdout.write(
      "Scenario applied: the index changed, draft.md moved, and archive/ was deleted. Use Undo set in the approval page to restore everything.\n",
    );
    if (automatic) {
      const state = await readState(port, token);
      const changeSet = state.changeSets.find((item) => item.label === "Organize project notes");
      if (!changeSet) throw new Error("Demo change set was not recorded");
      await post(port, token, `/api/change-sets/${changeSet.id}/undo`);
      await verifyRestored(workspace);
      process.stdout.write("Demo verification passed: all files and directories were restored.\n");
      return;
    }

    process.stdout.write("Press Ctrl+C when finished; the temporary workspace will be removed.\n");
    await signal;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await transport.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

async function seedWorkspace(workspace: string): Promise<void> {
  await mkdir(path.join(workspace, "notes"), { recursive: true });
  await mkdir(path.join(workspace, "archive", "empty"), { recursive: true });
  await writeFile(path.join(workspace, "index.md"), "# Project notes\n\n- draft\n");
  await writeFile(path.join(workspace, "notes", "draft.md"), "Draft notes\n");
  await writeFile(path.join(workspace, "archive", "old.md"), "Old notes\n");
}

async function verifyRestored(workspace: string): Promise<void> {
  const [index, draft, archived] = await Promise.all([
    readFile(path.join(workspace, "index.md"), "utf8"),
    readFile(path.join(workspace, "notes", "draft.md"), "utf8"),
    readFile(path.join(workspace, "archive", "old.md"), "utf8"),
  ]);
  if (index !== "# Project notes\n\n- draft\n") throw new Error("Demo index was not restored");
  if (draft !== "Draft notes\n") throw new Error("Demo draft was not restored");
  if (archived !== "Old notes\n") throw new Error("Demo archive was not restored");
  await readFile(path.join(workspace, "notes", "final.md"), "utf8").then(
    () => {
      throw new Error("Demo move destination still exists after undo");
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

async function ensureSuccess(resultPromise: Promise<unknown>): Promise<void> {
  const result = await resultPromise;
  if (!isCallToolResult(result)) throw new Error("Demo received an unsupported MCP task result");
  if (!result.isError) return;
  const message = result.content
    .filter((item) => item.type === "text")
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
  throw new Error(message || "Demo tool call failed");
}

function isCallToolResult(
  value: unknown,
): value is { isError?: boolean; content: Array<{ type: string; text?: string }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

async function approveNext(
  port: number,
  token: string,
  action: "approve" | "approve-set",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const state = await readState(port, token);
      if (state.pending[0]) {
        await post(port, token, `/api/approvals/${state.pending[0].id}/${action}`);
        return;
      }
    } catch {
      // The child binds the local HTTP server just before MCP initialization completes.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the demo approval");
}

async function readState(port: number, token: string): Promise<DemoState> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { "X-Agent-Rewind-Token": token },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DemoState>;
}

async function post(port: number, token: string, route: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "X-Agent-Rewind-Token": token },
  });
  if (!response.ok) throw new Error(await response.text());
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a demo port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
