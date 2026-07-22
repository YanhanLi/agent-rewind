import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true })));
});

it("approves, executes, records, and undoes a real filesystem MCP call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-e2e-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-data-"));
  directories.push(root, data);
  const target = path.join(root, "demo.txt");
  await writeFile(target, "original\n");
  const port = 33_000 + Math.floor(Math.random() * 2_000);
  const token = "integration-test-token";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "--port", String(port), root],
    env: {
      ...process.env,
      AGENT_REWIND_DATA_DIR: data,
      AGENT_REWIND_TOKEN: token,
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "write_file")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "rewind_begin_change_set")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "rewind_end_change_set")).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "rewind_delete_file")).toMatchObject({
      annotations: { destructiveHint: true },
    });
    expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/state`, {
          headers: {
            "X-Agent-Rewind-Token": token,
            Origin: "https://malicious.example",
          },
        })
      ).status,
    ).toBe(403);

    const escape = path.join(root, "outside");
    await symlink(data, escape);
    const escaped = await client.callTool({
      name: "write_file",
      arguments: { path: path.join(escape, "escaped.txt"), content: "must not be written" },
    });
    expect(escaped.isError).toBe(true);

    const begun = await client.callTool({
      name: "rewind_begin_change_set",
      arguments: { label: "Integration task" },
    });
    expect(begun.isError).not.toBe(true);

    const call = client.callTool({
      name: "write_file",
      arguments: { path: target, content: "agent change\n" },
    });
    const state = await waitForPending(port, token);
    await post(port, token, `/api/approvals/${state.pending[0].id}/approve-session`);
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(await readFile(target, "utf8")).toBe("agent change\n");

    const autoApproved = await client.callTool({
      name: "write_file",
      arguments: { path: path.join(root, "second.txt"), content: "same folder\n" },
    });
    expect(autoApproved.isError).not.toBe(true);

    await client.callTool({ name: "rewind_end_change_set", arguments: {} });
    const outsideSet = path.join(root, "outside-set.txt");
    const outsideResult = await client.callTool({
      name: "write_file",
      arguments: { path: outsideSet, content: "keep this\n" },
    });
    expect(outsideResult.isError).not.toBe(true);

    const recorded = await stateFor(port, token);
    expect(recorded.changeSets).toHaveLength(2);
    const taskSet = recorded.changeSets.find((changeSet) => changeSet.label === "Integration task");
    expect(taskSet?.actionCount).toBe(2);
    await post(port, token, `/api/change-sets/${taskSet!.id}/undo`);
    expect(await readFile(target, "utf8")).toBe("original\n");
    await expect(readFile(path.join(root, "second.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(outsideSet, "utf8")).toBe("keep this\n");

    const deleteDirectory = await client.callTool({
      name: "rewind_delete_file",
      arguments: { path: root },
    });
    expect(deleteDirectory.isError).toBe(true);

    await client.callTool({
      name: "rewind_begin_change_set",
      arguments: { label: "Deletion task" },
    });
    const deleteCall = client.callTool({
      name: "rewind_delete_file",
      arguments: { path: target },
    });
    const deleteApproval = await waitForPending(port, token);
    await post(port, token, `/api/approvals/${deleteApproval.pending[0].id}/approve`);
    const deleted = await deleteCall;
    expect(deleted.isError).not.toBe(true);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await client.callTool({ name: "rewind_end_change_set", arguments: {} });

    const afterDelete = await stateFor(port, token);
    const deletionSet = afterDelete.changeSets.find(
      (changeSet) => changeSet.label === "Deletion task",
    );
    expect(deletionSet?.actionCount).toBe(1);
    await post(port, token, `/api/change-sets/${deletionSet!.id}/undo`);
    expect(await readFile(target, "utf8")).toBe("original\n");

    const report = new Ledger(path.join(data, "ledger.sqlite")).validationReport();
    expect(report.approvals).toMatchObject({
      requested: 4,
      sessionApproved: 1,
      autoApproved: 2,
      approved: 1,
    });
    expect(report.changes).toMatchObject({ actions: 4, changeSets: 3, undone: 3 });
    expect(report.undo).toEqual({ attempted: 2, succeeded: 2, conflicts: 0 });
  } finally {
    await transport.close();
  }
}, 20_000);

interface UiState {
  pending: Array<{ id: string }>;
  changes: Array<{ id: string; summary: string }>;
  changeSets: Array<{ id: string; label?: string; actionCount: number }>;
}

async function stateFor(port: number, token: string): Promise<UiState> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { "X-Agent-Rewind-Token": token },
  });
  return response.json() as Promise<UiState>;
}

async function waitForPending(port: number, token: string): Promise<UiState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const state = await stateFor(port, token);
      if (state.pending.length > 0) return state;
    } catch {
      // The local UI can take a few milliseconds to bind after MCP initialization.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for approval request");
}

async function post(port: number, token: string, route: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "X-Agent-Rewind-Token": token },
  });
  if (!response.ok) throw new Error(await response.text());
}
