import { createTwoFilesPatch } from "diff";
import type {
  ChangeRecord,
  ChangeSetView,
  EntryState,
  LocalEvent,
  PathChange,
  RecoveryPreview,
  UndoReadiness,
} from "./model.js";
import { Ledger } from "./ledger.js";
import type { OperationLock } from "./operation-lock.js";
import {
  RewindConflictError,
  SnapshotIntegrityError,
  SnapshotStore,
} from "./snapshot-store.js";

export class RewindService {
  private readonly recoveryPreviewCache = new Map<string, RecoveryPreview[]>();

  constructor(
    private readonly ledger: Ledger,
    private readonly snapshots: SnapshotStore,
    private readonly operationLock: OperationLock = { run: (operation) => operation() },
  ) {}

  list(): ChangeRecord[] {
    return this.ledger.list();
  }

  listChangeSets(): ChangeSetView[] {
    return this.ledger.listChangeSets();
  }

  getChangeSet(id: string): ChangeSetView | undefined {
    return this.ledger.getChangeSet(id);
  }

  recordEvent(event: LocalEvent): void {
    this.ledger.recordEvent(event);
  }

  async recoverIntents(): Promise<{ recovered: number; discarded: number; pending: number }> {
    return this.operationLock.run(() => this.recoverIntentsLocked());
  }

  private async recoverIntentsLocked(): Promise<{
    recovered: number;
    discarded: number;
    pending: number;
  }> {
    let recovered = 0;
    let discarded = 0;
    let pending = 0;
    for (const intent of this.ledger.listIntents()) {
      try {
        const after = await Promise.all(
          intent.paths.map((change) => this.snapshots.captureForRecord(change.path)),
        );
        const paths: PathChange[] = intent.paths.map((change, index) => ({
          ...change,
          after: after[index],
        }));
        if (paths.some((change) => change.before.hash !== change.after.hash)) {
          const recoveredAt = new Date().toISOString();
          this.ledger.finalizeIntent(intent.id, {
            id: intent.id,
            changeSetId: intent.changeSetId,
            changeSetLabel: intent.changeSetLabel,
            tool: intent.tool,
            summary: intent.summary,
            createdAt: intent.createdAt,
            recoveredAt,
            status: "applied",
            paths,
          });
          this.ledger.recordEvent({ type: "intent_recovered", tool: intent.tool });
          this.ledger.recordEvent({ type: "change_applied", tool: intent.tool });
          recovered += 1;
        } else {
          this.ledger.discardIntent(intent.id);
          this.ledger.recordEvent({ type: "intent_discarded", tool: intent.tool });
          discarded += 1;
        }
      } catch {
        pending += 1;
      }
    }
    return { recovered, discarded, pending };
  }

  async reviewRecoveredChangeSet(id: string): Promise<ChangeSetView> {
    return this.operationLock.run(() => this.reviewRecoveredChangeSetLocked(id));
  }

  private async reviewRecoveredChangeSetLocked(id: string): Promise<ChangeSetView> {
    const existing = this.ledger.getChangeSet(id);
    if (!existing) throw new Error(`Unknown change set: ${id}`);
    if (!existing.recoveryStatus) {
      throw new Error("This change set was not recovered after an interruption");
    }
    if (existing.recoveryStatus === "reviewed") return existing;
    const changeSet = this.ledger.markRecoveryReviewed(id, new Date().toISOString());
    this.ledger.recordEvent({ type: "recovery_reviewed", target: "change_set" });
    return changeSet;
  }

  async recoveryPreviews(id: string): Promise<RecoveryPreview[]> {
    const cached = this.recoveryPreviewCache.get(id);
    if (cached) return cached;
    const changeSet = this.ledger.getChangeSet(id);
    if (!changeSet) throw new Error(`Unknown change set: ${id}`);
    if (!changeSet.recoveryStatus) {
      throw new Error("This change set was not recovered after an interruption");
    }
    const previews: RecoveryPreview[] = [];
    for (const record of changeSet.changes) {
      if (!record.recoveredAt) continue;
      for (const change of record.paths) {
        try {
          previews.push(await this.previewRecoveryPath(change));
        } catch {
          previews.push({
            path: change.path,
            kind: "summary",
            detail: "Preview unavailable. The snapshot is still retained for conflict checks and undo.",
          });
        }
      }
    }
    this.recoveryPreviewCache.set(id, previews);
    return previews;
  }

  async undoChangeSet(id: string): Promise<ChangeSetView> {
    return this.operationLock.run(() => this.undoChangeSetLocked(id));
  }

  async checkUndoReadiness(id: string): Promise<UndoReadiness> {
    return this.operationLock.run(async () => {
      const checkedAt = new Date().toISOString();
      try {
        await this.preflightChangeSet(id);
        return {
          status: "ready",
          checkedAt,
          message: "Current paths and required snapshots passed verification.",
        };
      } catch (error) {
        if (error instanceof RewindConflictError) {
          return {
            status: "conflict",
            checkedAt,
            message: "A path changed after the Agent action. Undo would preserve the newer content.",
            target: error.target,
          };
        }
        if (error instanceof SnapshotIntegrityError) {
          return {
            status: "snapshot_integrity",
            checkedAt,
            message: "A required recovery snapshot could not be verified.",
          };
        }
        return {
          status: "unavailable",
          checkedAt,
          message: error instanceof Error ? error.message : "Undo readiness could not be checked.",
        };
      }
    });
  }

  private async undoChangeSetLocked(id: string): Promise<ChangeSetView> {
    this.ledger.recordEvent({ type: "undo_started", target: "change_set" });
    try {
      const { records, initialByPath } = await this.preflightChangeSet(id);

      for (const record of [...records].reverse()) {
        if (record.status === "undone") continue;
        await this.undoRecord(record, true);
      }
      for (const change of initialByPath.values()) {
        const restored = await this.snapshots.inspect(change.path);
        if (!statesMatch(restored, change.before)) {
          throw new Error(`Change-set undo verification failed for ${change.path}`);
        }
      }
      this.ledger.recordEvent({ type: "undo_succeeded", target: "change_set" });
      return this.ledger.getChangeSet(id)!;
    } catch (error) {
      if (error instanceof RewindConflictError) {
        this.ledger.recordEvent({ type: "undo_conflict", target: "change_set" });
      }
      throw error;
    }
  }

  async undo(id: string): Promise<ChangeRecord> {
    return this.operationLock.run(() => this.undoLocked(id));
  }

  private async undoLocked(id: string): Promise<ChangeRecord> {
    this.ledger.recordEvent({ type: "undo_started", target: "change" });
    const record = this.ledger.get(id);
    if (!record) throw new Error(`Unknown change: ${id}`);
    if (record.status === "undone") throw new Error("Change is already undone");

    try {
      const result = await this.undoRecord(record);
      this.ledger.recordEvent({ type: "undo_succeeded", target: "change" });
      return result;
    } catch (error) {
      if (error instanceof RewindConflictError) {
        this.ledger.recordEvent({ type: "undo_conflict", target: "change" });
      }
      throw error;
    }
  }

  private async undoRecord(
    record: ChangeRecord,
    snapshotsVerified = false,
  ): Promise<ChangeRecord> {
    try {
      if (record.tool === "move_file") {
        await this.snapshots.undoMove(record.paths[0], record.paths[1]);
      } else {
        if (!snapshotsVerified) await this.verifyRecordSnapshots(record);
        for (const change of [...record.paths].reverse()) {
          await this.snapshots.restore(change);
        }
      }
      for (const change of record.paths) {
        const restored = await this.snapshots.inspect(change.path);
        if (!statesMatch(restored, change.before)) {
          throw new Error(`Undo verification failed for ${change.path}`);
        }
      }
      record.status = "undone";
    } catch (error) {
      if (error instanceof RewindConflictError) {
        record.status = "conflict";
        this.ledger.update(record);
      }
      throw error;
    }

    this.ledger.update(record);
    return record;
  }

  private async verifyRecordSnapshots(record: ChangeRecord): Promise<void> {
    for (const change of record.paths) {
      await this.snapshots.verifySnapshot(change.before, change.path);
    }
  }

  private async preflightChangeSet(id: string): Promise<{
    records: ChangeRecord[];
    initialByPath: Map<string, PathChange>;
  }> {
    const records = this.ledger.listByChangeSet(id);
    if (records.length === 0) throw new Error(`Unknown change set: ${id}`);
    if (records.every((record) => record.status === "undone")) {
      throw new Error("This change set is already undone");
    }
    const initialByPath = new Map<string, PathChange>();
    for (const record of records) {
      for (const change of record.paths) {
        if (!initialByPath.has(change.path)) initialByPath.set(change.path, change);
      }
    }

    // Simulate the whole reverse sequence before touching the filesystem. Each
    // applied action may be fully or partly restored already if the previous
    // process stopped between the filesystem change and the ledger update.
    const virtualState = new Map<string, EntryState>();
    await Promise.all(
      [...initialByPath.keys()].map(async (target) => {
        virtualState.set(target, await this.snapshots.inspect(target));
      }),
    );
    for (const record of [...records].reverse()) {
      if (record.status === "undone") continue;
      for (const change of record.paths) {
        const current = virtualState.get(change.path)!;
        if (!statesMatch(current, change.after) && !statesMatch(current, change.before)) {
          throw new RewindConflictError(change.path, change.after.hash, current.hash);
        }
        virtualState.set(change.path, change.before);
      }
    }
    for (const change of initialByPath.values()) {
      const final = virtualState.get(change.path)!;
      if (!statesMatch(final, change.before)) {
        throw new RewindConflictError(change.path, change.before.hash, final.hash);
      }
    }
    for (const record of records) {
      if (record.status === "undone" || record.tool === "move_file") continue;
      await this.verifyRecordSnapshots(record);
    }
    return { records, initialByPath };
  }

  private async previewRecoveryPath(change: PathChange): Promise<RecoveryPreview> {
    const maxSize = Math.max(fileSize(change.before), fileSize(change.after));
    if (
      change.before.kind === "directory" ||
      change.after.kind === "directory" ||
      maxSize > RECOVERY_TEXT_PREVIEW_MAX_BYTES
    ) {
      return {
        path: change.path,
        kind: "summary",
        detail: stateSummary(change.before, "before") + "\n" + stateSummary(change.after, "after"),
      };
    }
    const [beforeBuffer, afterBuffer] = await Promise.all([
      this.snapshots.readFileState(change.before),
      this.snapshots.readFileState(change.after),
    ]);
    if (!beforeBuffer || !afterBuffer) {
      return {
        path: change.path,
        kind: "summary",
        detail: stateSummary(change.before, "before") + "\n" + stateSummary(change.after, "after"),
      };
    }
    const before = decodeText(beforeBuffer);
    const after = decodeText(afterBuffer);
    if (before === undefined || after === undefined) {
      return {
        path: change.path,
        kind: "summary",
        detail:
          "Binary content is not displayed.\n" +
          stateSummary(change.before, "before") +
          "\n" +
          stateSummary(change.after, "after"),
      };
    }
    const diff = createTwoFilesPatch(change.path, change.path, before, after, "before", "after");
    return {
      path: change.path,
      kind: "text",
      detail:
        diff.length > RECOVERY_DIFF_MAX_CHARACTERS
          ? `${diff.slice(0, RECOVERY_DIFF_MAX_CHARACTERS)}\n\n[Diff truncated]`
          : diff,
    };
  }
}

const RECOVERY_TEXT_PREVIEW_MAX_BYTES = 128 * 1024;
const RECOVERY_DIFF_MAX_CHARACTERS = 40_000;

function fileSize(state: EntryState): number {
  return state.kind === "file" ? state.size : 0;
}

function statesMatch(left: EntryState, right: EntryState): boolean {
  return left.kind === right.kind && left.hash === right.hash;
}

function decodeText(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function stateSummary(state: EntryState, label: string): string {
  if (state.kind === "missing") return `${label}: missing`;
  if (state.kind === "file") {
    return `${label}: file, ${formatBytes(state.size)}, sha256 ${state.hash.slice(0, 12)}`;
  }
  const totals = directoryTotals(state);
  return `${label}: directory, ${totals.files} files, ${totals.directories} directories, ${formatBytes(totals.bytes)}, sha256 ${state.hash.slice(0, 12)}`;
}

function directoryTotals(state: EntryState): { files: number; directories: number; bytes: number } {
  if (state.kind !== "directory") return { files: 0, directories: 0, bytes: 0 };
  let files = 0;
  let directories = 1;
  let bytes = 0;
  for (const child of Object.values(state.children ?? {})) {
    if (child.kind === "file") {
      files += 1;
      bytes += child.size;
    } else if (child.kind === "directory") {
      const nested = directoryTotals(child);
      files += nested.files;
      directories += nested.directories;
      bytes += nested.bytes;
    }
  }
  return { files, directories, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
