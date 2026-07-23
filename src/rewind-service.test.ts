import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";
import type { ChangeIntent, ChangeRecord } from "./model.js";
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
    expect(changed.rewind.reviewRecoveredChangeSet(changedIntent.changeSetId).recoveryStatus).toBe(
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
    expect(await readFile(path.join(restoredTarget, "nested", "child.txt"), "utf8")).toBe(
      "child content\n",
    );
    expect((await lstat(path.join(restoredTarget, "empty"))).isDirectory()).toBe(true);

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

    const result = await rewind.undoChangeSet(changeSetId);

    expect(result.status).toBe("undone");
    expect(result.actionCount).toBe(2);
    expect(await readFile(target, "utf8")).toBe("original\n");
    expect(ledger.validationReport().undo).toEqual({ attempted: 1, succeeded: 1, conflicts: 0 });
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
    expect(await snapshots.garbageCollect(new Set([firstSnapshot.blob]))).toBe(0);
    expect(await snapshots.garbageCollect(new Set())).toBe(1);
    await expect(snapshots.capture(different)).resolves.toMatchObject({ kind: "file" });
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
