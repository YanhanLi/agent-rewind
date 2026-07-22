import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
});
