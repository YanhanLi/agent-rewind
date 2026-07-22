import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalServer } from "./approval-server.js";
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

    const rewind = { list: () => [], undo: async () => undefined } as unknown as RewindService;
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
});

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
