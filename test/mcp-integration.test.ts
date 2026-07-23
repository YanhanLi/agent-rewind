import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const directoryTarget = path.join(root, "archive");
  await mkdir(path.join(directoryTarget, "nested"), { recursive: true });
  await mkdir(path.join(directoryTarget, "empty"));
  await writeFile(path.join(directoryTarget, "nested", "note.txt"), "archived note\n");
  const port = 33_000 + Math.floor(Math.random() * 2_000);
  const token = "integration-test-token";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "--port", String(port), root],
    env: {
      ...process.env,
      AGENT_REWIND_DATA_DIR: data,
      AGENT_REWIND_TOKEN: token,
      AGENT_REWIND_CHANGE_SET_WINDOW_MS: "1000",
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
    expect(tools.tools.find((tool) => tool.name === "rewind_delete_directory")).toMatchObject({
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
    expect(state.pending[0]).toMatchObject({ changeSetLabel: "Integration task" });
    await post(port, token, `/api/approvals/${state.pending[0].id}/approve-set`);
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(await readFile(target, "utf8")).toBe("agent change\n");

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const autoApproved = await client.callTool({
      name: "write_file",
      arguments: { path: path.join(root, "second.txt"), content: "same folder\n" },
    });
    expect(autoApproved.isError).not.toBe(true);

    await client.callTool({ name: "rewind_end_change_set", arguments: {} });
    const outsideSet = path.join(root, "outside-set.txt");
    const outsideCall = client.callTool({
      name: "write_file",
      arguments: { path: outsideSet, content: "keep this\n" },
    });
    const outsideApproval = await waitForPending(port, token);
    await post(port, token, `/api/approvals/${outsideApproval.pending[0].id}/approve`);
    const outsideResult = await outsideCall;
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

    const deleteRoot = await client.callTool({
      name: "rewind_delete_directory",
      arguments: { path: root },
    });
    expect(deleteRoot.isError).toBe(true);

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

    await client.callTool({
      name: "rewind_begin_change_set",
      arguments: { label: "Directory deletion" },
    });
    const directoryDeleteCall = client.callTool({
      name: "rewind_delete_directory",
      arguments: { path: directoryTarget },
    });
    const directoryApproval = await waitForPending(port, token);
    expect(directoryApproval.pending[0].summary).toContain("Delete directory");
    await post(port, token, `/api/approvals/${directoryApproval.pending[0].id}/approve`);
    const directoryDeleted = await directoryDeleteCall;
    expect(directoryDeleted.isError).not.toBe(true);
    await expect(lstat(directoryTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await client.callTool({ name: "rewind_end_change_set", arguments: {} });

    const afterDirectoryDelete = await stateFor(port, token);
    const directorySet = afterDirectoryDelete.changeSets.find(
      (changeSet) => changeSet.label === "Directory deletion",
    );
    await post(port, token, `/api/change-sets/${directorySet!.id}/undo`);
    expect(await readFile(path.join(directoryTarget, "nested", "note.txt"), "utf8")).toBe(
      "archived note\n",
    );
    expect((await lstat(path.join(directoryTarget, "empty"))).isDirectory()).toBe(true);

    const report = new Ledger(path.join(data, "ledger.sqlite")).validationReport();
    expect(report.approvals).toMatchObject({
      requested: 5,
      changeSetApproved: 1,
      sessionApproved: 0,
      autoApproved: 1,
      approved: 3,
    });
    expect(report.changes).toMatchObject({ actions: 5, changeSets: 4, undone: 4 });
    expect(report.undo).toEqual({ attempted: 3, succeeded: 3, conflicts: 0 });
  } finally {
    await transport.close();
  }
}, 20_000);

it("recovers an approved mutation after the MCP process is killed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-crash-root-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-crash-data-"));
  directories.push(root, data);
  const target = path.join(root, "interrupted.txt");
  await writeFile(target, "before crash\n");
  const token = "crash-recovery-test-token";
  const firstPort = 35_100 + Math.floor(Math.random() * 200);
  const firstTransport = proxyTransport(root, data, token, firstPort, {
    AGENT_REWIND_TEST_CRASH_AFTER_MUTATION: "1",
  });
  const firstClient = new Client({ name: "crash-test", version: "1.0.0" });

  await firstClient.connect(firstTransport);
  const interruptedCall = firstClient.callTool({
    name: "write_file",
    arguments: { path: target, content: "after crash\n" },
  });
  const pending = await waitForPending(firstPort, token);
  await post(firstPort, token, `/api/approvals/${pending.pending[0].id}/approve`);
  await expect(interruptedCall).rejects.toThrow();
  await firstTransport.close().catch(() => undefined);
  expect(await readFile(target, "utf8")).toBe("after crash\n");

  const secondPort = firstPort + 300;
  const secondTransport = proxyTransport(root, data, token, secondPort);
  const secondClient = new Client({ name: "recovery-test", version: "1.0.0" });
  try {
    await secondClient.connect(secondTransport);
    const recovered = await stateFor(secondPort, token);
    expect(recovered.changeSets).toHaveLength(1);
    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.recovered[0]).toMatchObject({
      id: recovered.changeSets[0].id,
      recoveryStatus: "pending",
    });
    const previews = await recoveryPreviewsFor(
      secondPort,
      token,
      recovered.recovered[0].id,
    );
    expect(previews).toMatchObject([{ path: target, kind: "text" }]);
    expect(previews[0].detail).toContain("-before crash");
    expect(previews[0].detail).toContain("+after crash");
    await post(secondPort, token, `/api/change-sets/${recovered.changeSets[0].id}/review`);
    await post(secondPort, token, `/api/change-sets/${recovered.changeSets[0].id}/review`);
    const reviewed = await stateFor(secondPort, token);
    expect(reviewed.recovered).toHaveLength(0);
    expect(reviewed.changeSets[0].recoveryStatus).toBe("reviewed");
    await post(secondPort, token, `/api/change-sets/${recovered.changeSets[0].id}/undo`);
    expect(await readFile(target, "utf8")).toBe("before crash\n");

    const report = new Ledger(path.join(data, "ledger.sqlite")).validationReport();
    expect(report.recovery).toEqual({ recovered: 1, discarded: 0, reviewed: 1 });
  } finally {
    await secondTransport.close();
  }
}, 20_000);

it("serializes concurrent approved writes against the same captured state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-race-root-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-race-data-"));
  directories.push(root, data);
  const target = path.join(root, "shared.txt");
  await writeFile(target, "original\n");
  const token = "concurrent-write-test-token";
  const port = 35_700 + Math.floor(Math.random() * 200);
  const transport = proxyTransport(root, data, token, port);
  const client = new Client({ name: "concurrent-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    await client.callTool({
      name: "rewind_begin_change_set",
      arguments: { label: "Concurrent task" },
    });
    const firstCall = client.callTool({
      name: "write_file",
      arguments: { path: target, content: "first write\n" },
    });
    const secondCall = client.callTool({
      name: "write_file",
      arguments: { path: target, content: "second write\n" },
    });
    const pending = await waitForPendingCount(port, token, 2);
    await client.callTool({ name: "rewind_end_change_set", arguments: {} });
    await Promise.all(
      pending.pending.map((approval) =>
        post(port, token, `/api/approvals/${approval.id}/approve`),
      ),
    );
    const results = await Promise.all([firstCall, secondCall]);
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(["first write\n", "second write\n"]).toContain(await readFile(target, "utf8"));

    const state = await stateFor(port, token);
    expect(state.changes).toHaveLength(1);
    expect(state.changeSets).toHaveLength(1);
    expect(state.changeSets[0].label).toBe("Concurrent task");
    expect(new Ledger(path.join(data, "ledger.sqlite")).listIntents()).toHaveLength(0);
    await post(port, token, `/api/change-sets/${state.changeSets[0].id}/undo`);
    expect(await readFile(target, "utf8")).toBe("original\n");
  } finally {
    await transport.close();
  }
}, 20_000);

it("serializes approved writes across independent MCP processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-process-race-root-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-process-race-data-"));
  directories.push(root, data);
  const target = path.join(root, "shared.txt");
  await writeFile(target, "original\n");
  const firstPort = 36_100 + Math.floor(Math.random() * 100);
  const secondPort = firstPort + 200;
  const firstToken = "first-process-token";
  const secondToken = "second-process-token";
  const firstTransport = proxyTransport(root, data, firstToken, firstPort);
  const secondTransport = proxyTransport(root, data, secondToken, secondPort);
  const firstClient = new Client({ name: "first-process", version: "1.0.0" });
  const secondClient = new Client({ name: "second-process", version: "1.0.0" });

  try {
    await Promise.all([firstClient.connect(firstTransport), secondClient.connect(secondTransport)]);
    const firstCall = firstClient.callTool({
      name: "write_file",
      arguments: { path: target, content: "first process\n" },
    });
    const secondCall = secondClient.callTool({
      name: "write_file",
      arguments: { path: target, content: "second process\n" },
    });
    const [firstPending, secondPending] = await Promise.all([
      waitForPending(firstPort, firstToken),
      waitForPending(secondPort, secondToken),
    ]);
    await Promise.all([
      post(firstPort, firstToken, `/api/approvals/${firstPending.pending[0].id}/approve`),
      post(secondPort, secondToken, `/api/approvals/${secondPending.pending[0].id}/approve`),
    ]);

    const results = await Promise.all([firstCall, secondCall]);
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(["first process\n", "second process\n"]).toContain(await readFile(target, "utf8"));

    const state = await stateFor(firstPort, firstToken);
    expect(state.changes).toHaveLength(1);
    expect(state.changeSets).toHaveLength(1);
    await post(firstPort, firstToken, `/api/change-sets/${state.changeSets[0].id}/undo`);
    expect(await readFile(target, "utf8")).toBe("original\n");
  } finally {
    await Promise.allSettled([firstTransport.close(), secondTransport.close()]);
  }
}, 20_000);

it("does not reconcile another live process's in-flight intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-live-intent-root-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-live-intent-data-"));
  directories.push(root, data);
  const target = path.join(root, "in-flight.txt");
  await writeFile(target, "before\n");
  const firstPort = 36_500 + Math.floor(Math.random() * 100);
  const secondPort = firstPort + 200;
  const firstToken = "live-intent-first-token";
  const secondToken = "live-intent-second-token";
  const firstTransport = proxyTransport(root, data, firstToken, firstPort, {
    AGENT_REWIND_TEST_DELAY_AFTER_INTENT_MS: "750",
  });
  const secondTransport = proxyTransport(root, data, secondToken, secondPort);
  const firstClient = new Client({ name: "live-intent-first", version: "1.0.0" });
  const secondClient = new Client({ name: "live-intent-second", version: "1.0.0" });

  try {
    await firstClient.connect(firstTransport);
    const call = firstClient.callTool({
      name: "write_file",
      arguments: { path: target, content: "after\n" },
    });
    const pending = await waitForPending(firstPort, firstToken);
    await post(firstPort, firstToken, `/api/approvals/${pending.pending[0].id}/approve`);
    await waitForIntent(data);

    const secondConnected = secondClient.connect(secondTransport);
    const result = await call;
    expect(result.isError).not.toBe(true);
    await secondConnected;

    const state = await stateFor(secondPort, secondToken);
    expect(state.changes).toHaveLength(1);
    expect(state.recovered).toHaveLength(0);
    const ledger = new Ledger(path.join(data, "ledger.sqlite"));
    expect(ledger.listIntents()).toHaveLength(0);
    ledger.close();
  } finally {
    await Promise.allSettled([firstTransport.close(), secondTransport.close()]);
  }
}, 20_000);

it("revalidates root containment after approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-revalidate-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-revalidate-outside-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-revalidate-data-"));
  directories.push(root, outside, data);
  const parent = path.join(root, "replaceable");
  await mkdir(parent);
  const target = path.join(parent, "escaped.txt");
  const port = 36_900 + Math.floor(Math.random() * 100);
  const token = "root-revalidation-token";
  const transport = proxyTransport(root, data, token, port);
  const client = new Client({ name: "root-revalidation", version: "1.0.0" });

  try {
    await client.connect(transport);
    const call = client.callTool({
      name: "write_file",
      arguments: { path: target, content: "must stay inside\n" },
    });
    const pending = await waitForPending(port, token);
    await rm(parent, { recursive: true });
    await symlink(outside, parent);
    await post(port, token, `/api/approvals/${pending.pending[0].id}/approve`);

    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("outside") }),
      ]),
    );
    await expect(readFile(path.join(outside, "escaped.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await transport.close();
  }
}, 20_000);

function proxyTransport(
  root: string,
  data: string,
  token: string,
  port: number,
  extraEnvironment: Record<string, string> = {},
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "--port", String(port), root],
    env: {
      ...process.env,
      AGENT_REWIND_DATA_DIR: data,
      AGENT_REWIND_TOKEN: token,
      AGENT_REWIND_NO_BROWSER: "1",
      ...extraEnvironment,
    } as Record<string, string>,
    stderr: "pipe",
  });
}

async function waitForIntent(data: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ledger = new Ledger(path.join(data, "ledger.sqlite"));
    const count = ledger.listIntents().length;
    ledger.close();
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for an in-flight intent");
}

interface UiState {
  pending: Array<{ id: string; summary: string; changeSetLabel?: string }>;
  changes: Array<{ id: string; summary: string }>;
  changeSets: Array<{
    id: string;
    label?: string;
    actionCount: number;
    recoveryStatus?: "pending" | "reviewed";
  }>;
  recovered: Array<{
    id: string;
    recoveryStatus: "pending";
  }>;
}

async function recoveryPreviewsFor(
  port: number,
  token: string,
  changeSetId: string,
): Promise<Array<{ path: string; kind: "text" | "summary"; detail: string }>> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/change-sets/${changeSetId}/recovery-preview`,
    { headers: { "X-Agent-Rewind-Token": token } },
  );
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as { previews: Array<{ path: string; kind: "text" | "summary"; detail: string }> }).previews;
}

async function stateFor(port: number, token: string): Promise<UiState> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { "X-Agent-Rewind-Token": token },
  });
  return response.json() as Promise<UiState>;
}

async function waitForPending(port: number, token: string): Promise<UiState> {
  return waitForPendingCount(port, token, 1);
}

async function waitForPendingCount(
  port: number,
  token: string,
  count: number,
): Promise<UiState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const state = await stateFor(port, token);
      if (state.pending.length >= count) return state;
    } catch {
      // The local UI can take a few milliseconds to bind after MCP initialization.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} approval request(s)`);
}

async function post(port: number, token: string, route: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "X-Agent-Rewind-Token": token },
  });
  if (!response.ok) throw new Error(await response.text());
}
