import type { ChangeRecord, ChangeSetView, LocalEvent, PathChange } from "./model.js";
import { Ledger } from "./ledger.js";
import { RewindConflictError, SnapshotStore } from "./snapshot-store.js";

export class RewindService {
  constructor(
    private readonly ledger: Ledger,
    private readonly snapshots: SnapshotStore,
  ) {}

  list(): ChangeRecord[] {
    return this.ledger.list();
  }

  listChangeSets(): ChangeSetView[] {
    return this.ledger.listChangeSets();
  }

  recordEvent(event: LocalEvent): void {
    this.ledger.recordEvent(event);
  }

  async undoChangeSet(id: string): Promise<ChangeSetView> {
    this.ledger.recordEvent({ type: "undo_started", target: "change_set" });
    try {
      const records = this.ledger.listByChangeSet(id);
      if (records.length === 0) throw new Error(`Unknown change set: ${id}`);
      if (records.some((record) => record.status !== "applied")) {
        throw new Error("A change set can only be undone while all of its actions are applied");
      }

      // Preflight only the final expected state for each path. Earlier actions on
      // the same path become valid as later actions are reversed.
      const finalByPath = new Map<string, PathChange>();
      const initialByPath = new Map<string, PathChange>();
      for (const record of records) {
        for (const change of record.paths) {
          if (!initialByPath.has(change.path)) initialByPath.set(change.path, change);
          finalByPath.set(change.path, change);
        }
      }
      await Promise.all(
        [...finalByPath.values()].map((change) => this.snapshots.assertCurrent(change)),
      );

      for (const record of [...records].reverse()) {
        await this.undoRecord(record);
      }
      for (const change of initialByPath.values()) {
        const restored = await this.snapshots.capture(change.path);
        if (restored.kind !== change.before.kind || restored.hash !== change.before.hash) {
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
    this.ledger.recordEvent({ type: "undo_started", target: "change" });
    const record = this.ledger.get(id);
    if (!record) throw new Error(`Unknown change: ${id}`);
    if (record.status !== "applied") throw new Error(`Change is already ${record.status}`);

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

  private async undoRecord(record: ChangeRecord): Promise<ChangeRecord> {
    try {
      if (record.tool === "move_file") {
        await this.snapshots.undoMove(record.paths[0], record.paths[1]);
      } else {
        for (const change of [...record.paths].reverse()) {
          await this.snapshots.restore(change);
        }
      }
      for (const change of record.paths) {
        const restored = await this.snapshots.capture(change.path);
        if (restored.kind !== change.before.kind || restored.hash !== change.before.hash) {
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
}
