import type { ChangeRecord } from "./model.js";
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

  async undo(id: string): Promise<ChangeRecord> {
    const record = this.ledger.get(id);
    if (!record) throw new Error(`Unknown change: ${id}`);
    if (record.status !== "applied") throw new Error(`Change is already ${record.status}`);

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
