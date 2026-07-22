import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";
import type { ChangeRecord } from "./model.js";
import { RewindService } from "./rewind-service.js";
import { SnapshotStore } from "./snapshot-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-test-"));
  temporaryDirectories.push(directory);
  const snapshots = new SnapshotStore(path.join(directory, "blobs"));
  await snapshots.initialize();
  const ledger = new Ledger(path.join(directory, "ledger.sqlite"));
  return { directory, snapshots, ledger, rewind: new RewindService(ledger, snapshots) };
}

describe("RewindService", () => {
  it("restores an overwritten file and verifies the result", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "notes.txt");
    await writeFile(target, "before\n");
    const before = await snapshots.capture(target);
    await writeFile(target, "after\n");
    const after = await snapshots.capture(target);
    const record = change("write_file", [{ path: target, before, after }]);
    ledger.add(record);

    const result = await rewind.undo(record.id);

    expect(result.status).toBe("undone");
    expect(await readFile(target, "utf8")).toBe("before\n");
  });

  it("refuses to overwrite a file changed after the agent action", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "notes.txt");
    await writeFile(target, "before\n");
    const before = await snapshots.capture(target);
    await writeFile(target, "agent version\n");
    const after = await snapshots.capture(target);
    const record = change("write_file", [{ path: target, before, after }]);
    ledger.add(record);
    await writeFile(target, "user version\n");

    await expect(rewind.undo(record.id)).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(target, "utf8")).toBe("user version\n");
    expect(ledger.get(record.id)?.status).toBe("conflict");
  });

  it("moves a directory back when its state is unchanged", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await mkdir(source);
    await writeFile(path.join(source, "a.txt"), "content");
    const sourceBefore = await snapshots.capture(source);
    const destinationBefore = await snapshots.capture(destination);
    await rename(source, destination);
    const sourceAfter = await snapshots.capture(source);
    const destinationAfter = await snapshots.capture(destination);
    const record = change("move_file", [
      { path: source, before: sourceBefore, after: sourceAfter },
      { path: destination, before: destinationBefore, after: destinationAfter },
    ]);
    ledger.add(record);

    await rewind.undo(record.id);

    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("content");
  });
});

describe("SnapshotStore limits", () => {
  it("rejects oversized files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-limit-"));
    temporaryDirectories.push(directory);
    const snapshots = new SnapshotStore(path.join(directory, "blobs"), {
      maxFileBytes: 3,
      maxTotalBytes: 100,
    });
    await snapshots.initialize();
    const target = path.join(directory, "large.txt");
    await writeFile(target, "four");

    await expect(snapshots.capture(target)).rejects.toThrow("per-file limit");
  });

  it("deduplicates blobs before enforcing the total quota", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-quota-"));
    temporaryDirectories.push(directory);
    const snapshots = new SnapshotStore(path.join(directory, "blobs"), {
      maxFileBytes: 10,
      maxTotalBytes: 5,
    });
    await snapshots.initialize();
    const first = path.join(directory, "first.txt");
    const duplicate = path.join(directory, "duplicate.txt");
    const different = path.join(directory, "different.txt");
    await writeFile(first, "same");
    await writeFile(duplicate, "same");
    await writeFile(different, "xx");

    const firstSnapshot = await snapshots.capture(first);
    await snapshots.capture(duplicate);
    await expect(snapshots.capture(different)).rejects.toThrow("quota exceeded");
    expect(firstSnapshot.kind).toBe("file");
    if (firstSnapshot.kind !== "file") throw new Error("Expected file snapshot");
    expect(await snapshots.garbageCollect(new Set([firstSnapshot.blob]))).toBe(0);
    expect(await snapshots.garbageCollect(new Set())).toBe(1);
    await expect(snapshots.capture(different)).resolves.toMatchObject({ kind: "file" });
  });
});

function change(tool: string, paths: ChangeRecord["paths"]): ChangeRecord {
  return {
    id: randomUUID(),
    tool,
    summary: "test change",
    createdAt: new Date().toISOString(),
    status: "applied",
    paths,
  };
}
