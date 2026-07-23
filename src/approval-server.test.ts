import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalServer } from "./approval-server.js";
import type { ChangeRecord } from "./model.js";
import type { RewindService } from "./rewind-service.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe("ApprovalServer", () => {
  it("falls forward when the requested port is already occupied", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    cleanup.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));

    const rewind = {
      list: () => [],
      recordEvent: () => undefined,
      undo: async () => undefined,
    } as unknown as RewindService;
    const approval = new ApprovalServer(rewind, address.port);
    await approval.start();
    cleanup.push(() => approval.stop());

    expect(approval.port).toBe(address.port + 1);
  });

  it("reopens the browser only after the UI heartbeat becomes stale", async () => {
    const previousToken = process.env.AGENT_REWIND_TOKEN;
    process.env.AGENT_REWIND_TOKEN = "heartbeat-test-token";
    const opened: string[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const rewind = {
      list: () => [],
      listChangeSets: () => [],
      undo: async () => undefined,
      undoChangeSet: async () => undefined,
      recordEvent: () => undefined,
    } as unknown as RewindService;
    const approval = new ApprovalServer(
      rewind,
      32_190,
      120_000,
      (url) => opened.push(url),
      "darwin",
    );
    await approval.start();
    cleanup.push(async () => {
      await approval.stop();
      now.mockRestore();
      if (previousToken === undefined) delete process.env.AGENT_REWIND_TOKEN;
      else process.env.AGENT_REWIND_TOKEN = previousToken;
    });

    void approval.request(pendingInput("first"));
    expect(opened).toHaveLength(1);

    now.mockReturnValue(11_000);
    await fetch(`http://127.0.0.1:${approval.port}/api/state`, {
      headers: { "X-Agent-Rewind-Token": "heartbeat-test-token" },
    });
    now.mockReturnValue(12_000);
    void approval.request(pendingInput("second"));
    expect(opened).toHaveLength(1);

    now.mockReturnValue(15_001);
    void approval.request(pendingInput("third"));
    expect(opened).toHaveLength(2);
  });

  it("records approval expiry without retaining request details", async () => {
    const events: unknown[] = [];
    const rewind = {
      list: () => [],
      listChangeSets: () => [],
      recordEvent: (event: unknown) => events.push(event),
    } as unknown as RewindService;
    const approval = new ApprovalServer(rewind, 32_220, 10, () => undefined, "linux");
    await approval.start();
    cleanup.push(() => approval.stop());

    await expect(approval.request(pendingInput("private summary"))).resolves.toBe(false);

    expect(events).toEqual([
      { type: "approval_requested", tool: "write_file" },
      { type: "approval_expired", tool: "write_file" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private summary");
    expect(JSON.stringify(events)).not.toContain("/tmp/test.txt");
  });

  it("allows an explicit change set within its first folder and revokes the rule on end", async () => {
    const previousToken = process.env.AGENT_REWIND_TOKEN;
    process.env.AGENT_REWIND_TOKEN = "change-set-test-token";
    const events: unknown[] = [];
    const rewind = {
      list: () => [],
      listChangeSets: () => [],
      recordEvent: (event: unknown) => events.push(event),
    } as unknown as RewindService;
    const approval = new ApprovalServer(rewind, 32_230, 120_000, () => undefined, "linux");
    await approval.start();
    cleanup.push(async () => {
      await approval.stop();
      if (previousToken === undefined) delete process.env.AGENT_REWIND_TOKEN;
      else process.env.AGENT_REWIND_TOKEN = previousToken;
    });

    const first = approval.request({
      ...pendingInput("first action"),
      changeSetId: "set-1",
      changeSetLabel: "Refactor notes",
    });
    const state = await approvalState(approval.port, "change-set-test-token");
    await approvalPost(
      approval.port,
      "change-set-test-token",
      `/api/approvals/${state.pending[0].id}/approve-set`,
    );
    await expect(first).resolves.toBe(true);

    await expect(
      approval.request({
        ...pendingInput("second action"),
        tool: "edit_file",
        paths: ["/tmp/second.txt"],
        changeSetId: "set-1",
      }),
    ).resolves.toBe(true);

    const outsideScope = approval.request({
      ...pendingInput("outside scope"),
      paths: ["/var/tmp/outside.txt"],
      scope: "/var/tmp",
      changeSetId: "set-1",
    });
    const pendingOutside = await approvalState(approval.port, "change-set-test-token");
    await approvalPost(
      approval.port,
      "change-set-test-token",
      `/api/approvals/${pendingOutside.pending[0].id}/reject`,
    );
    await expect(outsideScope).resolves.toBe(false);

    approval.endChangeSet("set-1");
    const afterEnd = approval.request({
      ...pendingInput("after end"),
      changeSetId: "set-1",
    });
    const pendingAfterEnd = await approvalState(approval.port, "change-set-test-token");
    await approvalPost(
      approval.port,
      "change-set-test-token",
      `/api/approvals/${pendingAfterEnd.pending[0].id}/reject`,
    );
    await expect(afterEnd).resolves.toBe(false);

    expect(events).toEqual([
      { type: "approval_requested", tool: "write_file" },
      { type: "approval_change_set_approved", tool: "write_file" },
      { type: "approval_requested", tool: "edit_file" },
      { type: "approval_auto_approved", tool: "edit_file" },
      { type: "approval_requested", tool: "write_file" },
      { type: "approval_rejected", tool: "write_file" },
      { type: "approval_requested", tool: "write_file" },
      { type: "approval_rejected", tool: "write_file" },
    ]);
  });

  it("omits snapshot manifests from the history API", async () => {
    const previousToken = process.env.AGENT_REWIND_TOKEN;
    process.env.AGENT_REWIND_TOKEN = "public-history-test-token";
    const record: ChangeRecord = {
      id: "change-1",
      changeSetId: "set-1",
      tool: "rewind_delete_directory",
      summary: "Delete directory /tmp/archive",
      createdAt: new Date().toISOString(),
      status: "applied",
      paths: [
        {
          path: "/tmp/archive",
          before: {
            kind: "directory",
            hash: "directory-secret-hash",
            entries: ["private.txt:file:file-secret-hash"],
            children: {
              "private.txt": {
                kind: "file",
                hash: "file-secret-hash",
                blob: "blob-secret-hash",
                size: 10,
              },
            },
          },
          after: { kind: "missing", hash: "missing-secret-hash" },
        },
      ],
    };
    const rewind = {
      list: () => [record],
      listChangeSets: () => [
        {
          id: "set-1",
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          status: "applied",
          actionCount: 1,
          affectedPaths: ["/tmp/archive"],
          changes: [record],
        },
      ],
      recordEvent: () => undefined,
    } as unknown as RewindService;
    const approval = new ApprovalServer(rewind, 32_240, 120_000, () => undefined, "linux");
    await approval.start();
    cleanup.push(async () => {
      await approval.stop();
      if (previousToken === undefined) delete process.env.AGENT_REWIND_TOKEN;
      else process.env.AGENT_REWIND_TOKEN = previousToken;
    });

    const response = await fetch(`http://127.0.0.1:${approval.port}/api/state`, {
      headers: { "X-Agent-Rewind-Token": "public-history-test-token" },
    });
    const body = await response.text();

    expect(body).toContain("/tmp/archive");
    expect(body).not.toContain("private.txt");
    expect(body).not.toContain("secret-hash");
  });
});

async function approvalState(port: number, token: string): Promise<{ pending: Array<{ id: string }> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { "X-Agent-Rewind-Token": token },
  });
  return response.json() as Promise<{ pending: Array<{ id: string }> }>;
}

async function approvalPost(port: number, token: string, route: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "X-Agent-Rewind-Token": token },
  });
  if (!response.ok) throw new Error(await response.text());
}

function pendingInput(summary: string) {
  return {
    tool: "write_file",
    summary,
    detail: "preview",
    arguments: {},
    paths: ["/tmp/test.txt"],
    scope: "/tmp",
  };
}
