import { createTwoFilesPatch } from "diff";
import type {
  ChangeRecord,
  ChangeSetView,
  EntryState,
  LocalEvent,
  PathChange,
  RecoveryPreview,
} from "./model.js";
import { Ledger } from "./ledger.js";
import { RewindConflictError, SnapshotStore } from "./snapshot-store.js";

export class RewindService {
  private readonly recoveryPreviewCache = new Map<string, RecoveryPreview[]>();

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

  async recoverIntents(): Promise<{ recovered: number; discarded: number; pending: number }> {
    let recovered = 0;
    let discarded = 0;
    let pending = 0;
    for (const intent of this.ledger.listIntents()) {
      try {
        const after = await Promise.all(
          intent.paths.map((change) => this.snapshots.capture(change.path)),
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

  reviewRecoveredChangeSet(id: string): ChangeSetView {
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
