import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";
import type { ChangeIntent, ChangeRecord } from "./model.js";
import { SqliteOperationLock } from "./operation-lock.js";
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
  it("reconciles changed and unchanged write-ahead intents", async () => {
    const changed = await fixture();
    const changedTarget = path.join(changed.directory, "interrupted.txt");
    await writeFile(changedTarget, "before crash\n");
    const changedBefore = await changed.snapshots.capture(changedTarget);
    const changedIntent = intent("write_file", changedTarget, changedBefore);
    changed.ledger.beginIntent(changedIntent);
    await writeFile(changedTarget, "after crash\n");

    expect(changed.ledger.referencedBlobs()).toContain(
      changedBefore.kind === "file" ? changedBefore.blob : "",
    );
    await expect(changed.rewind.recoverIntents()).resolves.toEqual({
      recovered: 1,
      discarded: 0,
      pending: 0,
    });
    expect(changed.ledger.listIntents()).toHaveLength(0);
    expect(changed.ledger.get(changedIntent.id)?.status).toBe("applied");
    expect(changed.ledger.getChangeSet(changedIntent.changeSetId)?.recoveryStatus).toBe("pending");
    const previews = await changed.rewind.recoveryPreviews(changedIntent.changeSetId);
    expect(previews).toMatchObject([{ path: changedTarget, kind: "text" }]);
    expect(previews[0].detail).toContain("-before crash");
    expect(previews[0].detail).toContain("+after crash");
    expect((await changed.rewind.reviewRecoveredChangeSet(changedIntent.changeSetId)).recoveryStatus).toBe(
      "reviewed",
    );
    expect(changed.ledger.get(changedIntent.id)?.reviewedAt).toBeDefined();
    await changed.rewind.undo(changedIntent.id);
    expect(await readFile(changedTarget, "utf8")).toBe("before crash\n");

    const unchanged = await fixture();
    const unchangedTarget = path.join(unchanged.directory, "not-executed.txt");
    await writeFile(unchangedTarget, "unchanged\n");
    const unchangedBefore = await unchanged.snapshots.capture(unchangedTarget);
    unchanged.ledger.beginIntent(intent("write_file", unchangedTarget, unchangedBefore));

    await expect(unchanged.rewind.recoverIntents()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      pending: 0,
    });
    expect(unchanged.ledger.listIntents()).toHaveLength(0);
    expect(unchanged.ledger.list()).toHaveLength(0);
  });

  it("keeps an intent and its snapshot when startup reconciliation cannot inspect the target", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "unreadable-target.txt");
    await writeFile(target, "before crash\n");
    const before = await snapshots.capture(target);
    const pendingIntent = intent("write_file", target, before);
    ledger.beginIntent(pendingIntent);
    await rm(target);
    await symlink(path.join(directory, "missing-link-target"), target);

    await expect(rewind.recoverIntents()).resolves.toEqual({
      recovered: 0,
      discarded: 0,
      pending: 1,
    });
    expect(ledger.listIntents()).toEqual([pendingIntent]);
    expect(ledger.referencedBlobs()).toContain(before.kind === "file" ? before.blob : "");
  });

  it("does not let concurrent recovery review overwrite an undo", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-review-race-"));
    temporaryDirectories.push(directory);
    const snapshots = new SnapshotStore(path.join(directory, "blobs"));
    await snapshots.initialize();
    const filename = path.join(directory, "ledger.sqlite");
    const firstLedger = new Ledger(filename);
    const secondLedger = new Ledger(filename);
    const lockFilename = path.join(directory, "operation-lock.sqlite");
    const first = new RewindService(
      firstLedger,
      snapshots,
      new SqliteOperationLock(lockFilename, 5),
    );
    const second = new RewindService(
      secondLedger,
      snapshots,
      new SqliteOperationLock(lockFilename, 5),
    );
    const target = path.join(directory, "recovered.txt");
    await writeFile(target, "before\n");
    const before = await snapshots.capture(target);
    const pending = intent("write_file", target, before);
    firstLedger.beginIntent(pending);
    await writeFile(target, "after\n");
    await first.recoverIntents();

    const results = await Promise.allSettled([
      first.reviewRecoveredChangeSet(pending.changeSetId),
      second.undo(pending.id),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(firstLedger.get(pending.id)?.status).toBe("undone");
    expect(await readFile(target, "utf8")).toBe("before\n");
    firstLedger.close();
    secondLedger.close();
  });

  it("uses summaries instead of displaying binary or large recovered files", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const binaryTarget = path.join(directory, "image.bin");
    const largeTarget = path.join(directory, "large.txt");
    await writeFile(binaryTarget, Buffer.from([0, 1, 2, 255]));
    await writeFile(largeTarget, Buffer.alloc(128 * 1024 + 1, 65));
    const [binaryBefore, largeBefore] = await Promise.all([
      snapshots.capture(binaryTarget),
      snapshots.capture(largeTarget),
    ]);
    await writeFile(binaryTarget, Buffer.from([0, 3, 4, 255]));
    await writeFile(largeTarget, Buffer.alloc(128 * 1024 + 1, 66));
    const [binaryAfter, largeAfter] = await Promise.all([
      snapshots.capture(binaryTarget),
      snapshots.capture(largeTarget),
    ]);
    const id = randomUUID();
    ledger.add({
      id,
      changeSetId: id,
      tool: "write_file",
      summary: "Recovered non-previewable files",
      createdAt: new Date().toISOString(),
      recoveredAt: new Date().toISOString(),
      status: "applied",
      paths: [
        { path: binaryTarget, before: binaryBefore, after: binaryAfter },
        { path: largeTarget, before: largeBefore, after: largeAfter },
      ],
    });

    const previews = await rewind.recoveryPreviews(id);
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({ path: binaryTarget, kind: "summary" });
    expect(previews[0].detail).toContain("Binary content is not displayed");
    expect(previews[1]).toMatchObject({ path: largeTarget, kind: "summary" });
    expect(previews[1].detail).toContain("sha256");
    expect(previews[1].detail).not.toContain("AAAA");
  });

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
    expect(ledger.validationReport().undo).toEqual({ attempted: 1, succeeded: 0, conflicts: 1 });
  });

  it("restores a deleted file and rejects undo after the path is recreated", async () => {
    const first = await fixture();
    const restoredTarget = path.join(first.directory, "deleted.txt");
    await writeFile(restoredTarget, "restore me\n");
    const restoredBefore = await first.snapshots.capture(restoredTarget);
    await rm(restoredTarget);
    const restoredAfter = await first.snapshots.capture(restoredTarget);
    const restoredRecord = change("rewind_delete_file", [
      { path: restoredTarget, before: restoredBefore, after: restoredAfter },
    ]);
    first.ledger.add(restoredRecord);

    await first.rewind.undo(restoredRecord.id);
    expect(await readFile(restoredTarget, "utf8")).toBe("restore me\n");

    const second = await fixture();
    const conflictedTarget = path.join(second.directory, "deleted.txt");
    await writeFile(conflictedTarget, "agent deleted this\n");
    const conflictedBefore = await second.snapshots.capture(conflictedTarget);
    await rm(conflictedTarget);
    const conflictedAfter = await second.snapshots.capture(conflictedTarget);
    const conflictedRecord = change("rewind_delete_file", [
      { path: conflictedTarget, before: conflictedBefore, after: conflictedAfter },
    ]);
    second.ledger.add(conflictedRecord);
    await writeFile(conflictedTarget, "user recreated this\n");

    await expect(second.rewind.undo(conflictedRecord.id)).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(await readFile(conflictedTarget, "utf8")).toBe("user recreated this\n");
  });

  it("restores a deleted directory manifest and protects a recreated path", async () => {
    const first = await fixture();
    const restoredTarget = path.join(first.directory, "deleted-directory");
    await mkdir(path.join(restoredTarget, "nested"), { recursive: true });
    await mkdir(path.join(restoredTarget, "empty"));
    await writeFile(path.join(restoredTarget, "Z.txt"), "uppercase sorts first\n");
    await writeFile(path.join(restoredTarget, "a.txt"), "lowercase sorts second\n");
    await writeFile(path.join(restoredTarget, "root.txt"), "root content\n");
    await writeFile(path.join(restoredTarget, "nested", "child.txt"), "child content\n");
    const restoredBefore = await first.snapshots.capture(restoredTarget);
    await rm(restoredTarget, { recursive: true });
    const restoredAfter = await first.snapshots.capture(restoredTarget);
    const restoredRecord = change("rewind_delete_directory", [
      { path: restoredTarget, before: restoredBefore, after: restoredAfter },
    ]);
    first.ledger.add(restoredRecord);
    expect(await first.snapshots.garbageCollect(first.ledger.referencedBlobs())).toBe(0);

    await first.rewind.undo(restoredRecord.id);
    expect(await readFile(path.join(restoredTarget, "root.txt"), "utf8")).toBe("root content\n");
    expect(await readFile(path.join(restoredTarget, "Z.txt"), "utf8")).toBe(
      "uppercase sorts first\n",
    );
    expect(await readFile(path.join(restoredTarget, "nested", "child.txt"), "utf8")).toBe(
      "child content\n",
    );
    expect((await lstat(path.join(restoredTarget, "empty"))).isDirectory()).toBe(true);
    expect(await readdir(restoredTarget)).not.toContain(".agent-rewind-staging.json");

    const second = await fixture();
    const conflictedTarget = path.join(second.directory, "deleted-directory");
    await mkdir(conflictedTarget);
    await writeFile(path.join(conflictedTarget, "agent.txt"), "agent file\n");
    const conflictedBefore = await second.snapshots.capture(conflictedTarget);
    await rm(conflictedTarget, { recursive: true });
    const conflictedAfter = await second.snapshots.capture(conflictedTarget);
    const conflictedRecord = change("rewind_delete_directory", [
      { path: conflictedTarget, before: conflictedBefore, after: conflictedAfter },
    ]);
    second.ledger.add(conflictedRecord);
    await writeFile(conflictedTarget, "user replacement\n");

    await expect(second.rewind.undo(conflictedRecord.id)).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(await readFile(conflictedTarget, "utf8")).toBe("user replacement\n");
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

  it("finishes a move undo after the rename completed before a crash", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const source = path.join(directory, "interrupted-source.txt");
    const destination = path.join(directory, "interrupted-destination.txt");
    await writeFile(source, "content\n");
    const sourceBefore = await snapshots.capture(source);
    const destinationBefore = await snapshots.capture(destination);
    await rename(source, destination);
    const record = change("move_file", [
      { path: source, before: sourceBefore, after: await snapshots.capture(source) },
      {
        path: destination,
        before: destinationBefore,
        after: await snapshots.capture(destination),
      },
    ]);
    ledger.add(record);

    await snapshots.undoMove(record.paths[0], record.paths[1]);
    expect(ledger.get(record.id)?.status).toBe("applied");

    await expect(rewind.undo(record.id)).resolves.toMatchObject({ status: "undone" });
    expect(await readFile(source, "utf8")).toBe("content\n");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("undoes multiple writes to the same path as one change set", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "draft.txt");
    const changeSetId = randomUUID();
    await writeFile(target, "original\n");
    const original = await snapshots.capture(target);
    await writeFile(target, "middle\n");
    const middle = await snapshots.capture(target);
    ledger.add(change("write_file", [{ path: target, before: original, after: middle }], changeSetId));
    await writeFile(target, "final\n");
    const final = await snapshots.capture(target);
    ledger.add(change("write_file", [{ path: target, before: middle, after: final }], changeSetId));

    await expect(rewind.checkUndoReadiness(changeSetId)).resolves.toMatchObject({
      status: "ready",
    });
    const result = await rewind.undoChangeSet(changeSetId);

    expect(result.status).toBe("undone");
    expect(result.actionCount).toBe(2);
    expect(await readFile(target, "utf8")).toBe("original\n");
    expect(ledger.validationReport().undo).toEqual({ attempted: 1, succeeded: 1, conflicts: 0 });
  });

  it("finishes a single undo after the filesystem was restored before a crash", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "interrupted-undo.txt");
    await writeFile(target, "before\n");
    const before = await snapshots.capture(target);
    await writeFile(target, "after\n");
    const after = await snapshots.capture(target);
    const record = change("write_file", [{ path: target, before, after }]);
    ledger.add(record);

    await snapshots.restore(record.paths[0]);
    expect(ledger.get(record.id)?.status).toBe("applied");

    await expect(rewind.undo(record.id)).resolves.toMatchObject({ status: "undone" });
    expect(await readFile(target, "utf8")).toBe("before\n");
  });

  it("finishes undoing a created directory after it was atomically quarantined", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "created-directory");
    const before = await snapshots.capture(target);
    await mkdir(path.join(target, "nested"), { recursive: true });
    await writeFile(path.join(target, "nested", "content.txt"), "created by agent\n");
    const after = await snapshots.capture(target);
    const record = change("create_directory", [{ path: target, before, after }]);
    ledger.add(record);

    const targetHash = createHash("sha256")
      .update(path.resolve(target))
      .digest("hex")
      .slice(0, 16);
    const staging = await mkdtemp(
      path.join(directory, `.agent-rewind-restore-${targetHash}-`),
    );
    await writeFile(
      path.join(staging, ".agent-rewind-staging.json"),
      JSON.stringify({ version: 1, target: path.resolve(target) }),
    );
    await rename(target, path.join(staging, "entry"));
    const unowned = await mkdtemp(
      path.join(directory, `.agent-rewind-restore-${targetHash}-`),
    );

    await expect(rewind.undo(record.id)).resolves.toMatchObject({ status: "undone" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(unowned)).isDirectory()).toBe(true);
  });

  it("resumes a change-set undo after its last action was restored before a crash", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "resumable-change-set.txt");
    const changeSetId = randomUUID();
    await writeFile(target, "original\n");
    const original = await snapshots.capture(target);
    await writeFile(target, "middle\n");
    const middle = await snapshots.capture(target);
    const first = change(
      "write_file",
      [{ path: target, before: original, after: middle }],
      changeSetId,
    );
    ledger.add(first);
    await writeFile(target, "final\n");
    const final = await snapshots.capture(target);
    const second = change(
      "write_file",
      [{ path: target, before: middle, after: final }],
      changeSetId,
    );
    second.createdAt = first.createdAt;
    ledger.add(second);

    await snapshots.restore(second.paths[0]);
    expect(ledger.get(second.id)?.status).toBe("applied");

    const result = await rewind.undoChangeSet(changeSetId);
    expect(result.status).toBe("undone");
    expect(await readFile(target, "utf8")).toBe("original\n");
  });

  it("resumes a change-set undo with actions already marked undone", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const firstTarget = path.join(directory, "first-resumed.txt");
    const secondTarget = path.join(directory, "second-resumed.txt");
    const changeSetId = randomUUID();
    await writeFile(firstTarget, "first before\n");
    await writeFile(secondTarget, "second before\n");
    const firstBefore = await snapshots.capture(firstTarget);
    const secondBefore = await snapshots.capture(secondTarget);
    await writeFile(firstTarget, "first after\n");
    await writeFile(secondTarget, "second after\n");
    const first = change(
      "write_file",
      [{ path: firstTarget, before: firstBefore, after: await snapshots.capture(firstTarget) }],
      changeSetId,
    );
    const second = change(
      "write_file",
      [{ path: secondTarget, before: secondBefore, after: await snapshots.capture(secondTarget) }],
      changeSetId,
    );
    ledger.add(first);
    ledger.add(second);
    await snapshots.restore(second.paths[0]);
    second.status = "undone";
    ledger.update(second);

    expect(ledger.getChangeSet(changeSetId)?.status).toBe("partial");
    await expect(rewind.checkUndoReadiness(changeSetId)).resolves.toMatchObject({
      status: "ready",
    });
    const result = await rewind.undoChangeSet(changeSetId);
    expect(result.status).toBe("undone");
    expect(await readFile(firstTarget, "utf8")).toBe("first before\n");
    expect(await readFile(secondTarget, "utf8")).toBe("second before\n");
  });

  it("does not overwrite a file with a corrupted snapshot blob", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "corrupt-file.txt");
    await writeFile(target, "trusted before\n");
    const before = await snapshots.capture(target);
    await writeFile(target, "current after\n");
    const after = await snapshots.capture(target);
    const record = change("write_file", [{ path: target, before, after }]);
    ledger.add(record);
    if (before.kind !== "file") throw new Error("Expected file snapshot");
    await writeFile(path.join(directory, "blobs", before.blob), "corrupt\n");

    await expect(rewind.undo(record.id)).rejects.toThrow("failed verification");
    expect(await readFile(target, "utf8")).toBe("current after\n");
    expect(ledger.get(record.id)?.status).toBe("applied");
  });

  it("leaves no partial directory when a nested snapshot blob is corrupted", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const target = path.join(directory, "corrupt-directory");
    await mkdir(path.join(target, "nested"), { recursive: true });
    await writeFile(path.join(target, "root.txt"), "root\n");
    await writeFile(path.join(target, "nested", "child.txt"), "child\n");
    const before = await snapshots.capture(target);
    await rm(target, { recursive: true });
    const after = await snapshots.capture(target);
    const record = change("rewind_delete_directory", [{ path: target, before, after }]);
    ledger.add(record);
    if (before.kind !== "directory") throw new Error("Expected directory snapshot");
    const nested = before.children?.nested;
    const child = nested?.kind === "directory" ? nested.children?.["child.txt"] : undefined;
    if (child?.kind !== "file") throw new Error("Expected nested file snapshot");
    await writeFile(path.join(directory, "blobs", child.blob), "corrupt\n");

    await expect(rewind.undo(record.id)).rejects.toThrow("failed verification");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).filter((name) => name.startsWith(".agent-rewind-restore-"))).toEqual([]);
    expect(ledger.get(record.id)?.status).toBe("applied");
  });

  it("preflights every snapshot before changing any path in a change set", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const firstTarget = path.join(directory, "first-integrity.txt");
    const secondTarget = path.join(directory, "second-integrity.txt");
    const changeSetId = randomUUID();
    await writeFile(firstTarget, "first before\n");
    await writeFile(secondTarget, "second before\n");
    const firstBefore = await snapshots.capture(firstTarget);
    const secondBefore = await snapshots.capture(secondTarget);
    await writeFile(firstTarget, "first after\n");
    await writeFile(secondTarget, "second after\n");
    ledger.add(
      change(
        "write_file",
        [{ path: firstTarget, before: firstBefore, after: await snapshots.capture(firstTarget) }],
        changeSetId,
      ),
    );
    ledger.add(
      change(
        "write_file",
        [
          {
            path: secondTarget,
            before: secondBefore,
            after: await snapshots.capture(secondTarget),
          },
        ],
        changeSetId,
      ),
    );
    if (firstBefore.kind !== "file") throw new Error("Expected file snapshot");
    await writeFile(path.join(directory, "blobs", firstBefore.blob), "corrupt\n");

    await expect(rewind.checkUndoReadiness(changeSetId)).resolves.toMatchObject({
      status: "snapshot_integrity",
    });
    await expect(rewind.undoChangeSet(changeSetId)).rejects.toThrow("failed verification");
    expect(await readFile(firstTarget, "utf8")).toBe("first after\n");
    expect(await readFile(secondTarget, "utf8")).toBe("second after\n");
    expect(ledger.listByChangeSet(changeSetId).every((record) => record.status === "applied")).toBe(
      true,
    );
  });

  it("does not partially undo a change set when preflight finds a conflict", async () => {
    const { directory, snapshots, ledger, rewind } = await fixture();
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const changeSetId = randomUUID();
    await writeFile(first, "first before\n");
    await writeFile(second, "second before\n");
    const firstBefore = await snapshots.capture(first);
    const secondBefore = await snapshots.capture(second);
    await writeFile(first, "first after\n");
    await writeFile(second, "second after\n");
    const firstAfter = await snapshots.capture(first);
    const secondAfter = await snapshots.capture(second);
    ledger.add(
      change("write_file", [{ path: first, before: firstBefore, after: firstAfter }], changeSetId),
    );
    ledger.add(
      change("write_file", [{ path: second, before: secondBefore, after: secondAfter }], changeSetId),
    );
    await writeFile(second, "user edit\n");

    await expect(rewind.checkUndoReadiness(changeSetId)).resolves.toMatchObject({
      status: "conflict",
      target: second,
    });
    await expect(rewind.undoChangeSet(changeSetId)).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(first, "utf8")).toBe("first after\n");
    expect(await readFile(second, "utf8")).toBe("user edit\n");
    expect(ledger.listByChangeSet(changeSetId).every((record) => record.status === "applied")).toBe(
      true,
    );
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
    expect(await snapshots.garbageCollect(new Set([firstSnapshot.blob]), 0)).toBe(0);
    expect(await snapshots.garbageCollect(new Set())).toBe(0);
    expect(await snapshots.garbageCollect(new Set(), 0)).toBe(1);
    await expect(snapshots.capture(different)).resolves.toMatchObject({ kind: "file" });
  });

  it("serializes quota checks for concurrent new blobs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-quota-race-"));
    temporaryDirectories.push(directory);
    const snapshots = new SnapshotStore(path.join(directory, "blobs"), {
      maxFileBytes: 10,
      maxTotalBytes: 5,
    });
    await snapshots.initialize();
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    await writeFile(first, "one");
    await writeFile(second, "two");

    const results = await Promise.allSettled([snapshots.capture(first), snapshots.capture(second)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("refreshes a reused blob's grace period before garbage collection", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-gc-grace-"));
    temporaryDirectories.push(directory);
    const snapshots = new SnapshotStore(path.join(directory, "blobs"));
    await snapshots.initialize();
    const target = path.join(directory, "pending.txt");
    await writeFile(target, "pending approval\n");
    const snapshot = await snapshots.capture(target);
    if (snapshot.kind !== "file") throw new Error("Expected file snapshot");
    const blob = path.join(directory, "blobs", snapshot.blob);
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(blob, old, old);

    await snapshots.capture(target);

    expect(await snapshots.garbageCollect(new Set(), 5 * 60 * 1_000)).toBe(0);
  });

  it("records a hash-only after state when snapshot storage is unavailable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-after-state-"));
    temporaryDirectories.push(directory);
    const snapshots = new SnapshotStore(path.join(directory, "blobs"), {
      maxFileBytes: 3,
      maxTotalBytes: 1,
    });
    await snapshots.initialize();
    const target = path.join(directory, "after.txt");
    await writeFile(target, "larger than both limits\n");

    await expect(snapshots.capture(target)).rejects.toThrow("per-file limit");
    const state = await snapshots.captureForRecord(target);

    expect(state).toMatchObject({ kind: "file", size: 24 });
    if (state.kind !== "file") throw new Error("Expected file state");
    await expect(readFile(path.join(directory, "blobs", state.blob))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      snapshots.assertCurrent({ path: target, before: { kind: "missing", hash: "unused" }, after: state }),
    ).resolves.toBeUndefined();
  });
});

describe("Ledger compatibility", () => {
  it("treats v0.2 records without a change-set id as single-action sets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-ledger-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "ledger.sqlite");
    const ledger = new Ledger(filename);
    const legacy = change("write_file", []);
    const { changeSetId: _changeSetId, ...payload } = legacy;
    const database = new DatabaseSync(filename);
    database
      .prepare("INSERT INTO changes (id, created_at, status, payload) VALUES (?, ?, ?, ?)")
      .run(legacy.id, legacy.createdAt, legacy.status, JSON.stringify(payload));
    database.close();

    const sets = ledger.listChangeSets();

    expect(sets).toHaveLength(1);
    expect(sets[0].id).toBe(legacy.id);
    expect(sets[0].actionCount).toBe(1);
  });

  it("aggregates validation events without path or content columns", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-events-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "ledger.sqlite");
    const ledger = new Ledger(filename);
    ledger.recordEvent({ type: "approval_requested", tool: "write_file" });
    ledger.recordEvent({ type: "approval_approved", tool: "write_file" });
    ledger.recordEvent({ type: "change_applied", tool: "write_file" });
    ledger.recordEvent({ type: "undo_started", target: "change_set" });
    ledger.recordEvent({ type: "undo_succeeded", target: "change_set" });

    const report = ledger.validationReport();
    const database = new DatabaseSync(filename);
    const columns = database.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    database.close();

    expect(report.approvals).toMatchObject({ requested: 1, approved: 1 });
    expect(report.undo).toEqual({ attempted: 1, succeeded: 1, conflicts: 0 });
    expect(report.tools).toEqual({ write_file: 1 });
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "created_at",
      "type",
      "tool",
      "target",
    ]);
  });
});

function change(
  tool: string,
  paths: ChangeRecord["paths"],
  changeSetId = randomUUID(),
): ChangeRecord {
  return {
    id: randomUUID(),
    changeSetId,
    tool,
    summary: "test change",
    createdAt: new Date().toISOString(),
    status: "applied",
    paths,
  };
}

function intent(
  tool: string,
  target: string,
  before: ChangeIntent["paths"][number]["before"],
): ChangeIntent {
  const id = randomUUID();
  return {
    id,
    changeSetId: id,
    tool,
    summary: "test intent",
    createdAt: new Date().toISOString(),
    paths: [{ path: target, before }],
  };
}
