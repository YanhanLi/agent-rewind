import { DatabaseSync } from "node:sqlite";
import type { ChangeRecord, ChangeSetView } from "./model.js";

export class Ledger {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
  }

  add(record: ChangeRecord): void {
    this.database
      .prepare("INSERT INTO changes (id, created_at, status, payload) VALUES (?, ?, ?, ?)")
      .run(record.id, record.createdAt, record.status, JSON.stringify(record));
  }

  update(record: ChangeRecord): void {
    this.database
      .prepare("UPDATE changes SET status = ?, payload = ? WHERE id = ?")
      .run(record.status, JSON.stringify(record), record.id);
  }

  get(id: string): ChangeRecord | undefined {
    const row = this.database.prepare("SELECT payload FROM changes WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return row ? parseRecord(row.payload) : undefined;
  }

  list(limit = 50): ChangeRecord[] {
    const rows = this.database
      .prepare("SELECT payload FROM changes ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ payload: string }>;
    return rows.map((row) => parseRecord(row.payload));
  }

  listByChangeSet(changeSetId: string): ChangeRecord[] {
    const rows = this.database.prepare("SELECT payload FROM changes ORDER BY created_at ASC").all() as Array<{
      payload: string;
    }>;
    return rows.map((row) => parseRecord(row.payload)).filter((record) => record.changeSetId === changeSetId);
  }

  getChangeSet(changeSetId: string): ChangeSetView | undefined {
    const changes = this.listByChangeSet(changeSetId);
    return changes.length > 0 ? toChangeSet(changeSetId, changes) : undefined;
  }

  listChangeSets(limit = 20): ChangeSetView[] {
    const groups = new Map<string, ChangeRecord[]>();
    for (const record of this.list(500)) {
      const group = groups.get(record.changeSetId) ?? [];
      group.push(record);
      groups.set(record.changeSetId, group);
    }
    return [...groups.entries()]
      .map(([id, changes]) => toChangeSet(id, changes))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  pruneBefore(cutoff: Date): number {
    const result = this.database
      .prepare("DELETE FROM changes WHERE created_at < ?")
      .run(cutoff.toISOString());
    return Number(result.changes);
  }

  referencedBlobs(): Set<string> {
    const rows = this.database.prepare("SELECT payload FROM changes").all() as Array<{
      payload: string;
    }>;
    const blobs = new Set<string>();
    for (const row of rows) {
      const record = parseRecord(row.payload);
      for (const change of record.paths) {
        if (change.before.kind === "file") blobs.add(change.before.blob);
        if (change.after.kind === "file") blobs.add(change.after.blob);
      }
    }
    return blobs;
  }
}

function parseRecord(payload: string): ChangeRecord {
  const record = JSON.parse(payload) as ChangeRecord & { changeSetId?: string };
  return { ...record, changeSetId: record.changeSetId ?? record.id };
}

function toChangeSet(id: string, input: ChangeRecord[]): ChangeSetView {
  const changes = [...input].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const statuses = new Set(changes.map((change) => change.status));
  const status: ChangeSetView["status"] =
    statuses.size === 1
      ? (changes[0].status as "applied" | "undone" | "conflict")
      : statuses.has("conflict")
        ? "conflict"
        : "partial";
  return {
    id,
    createdAt: changes[0].createdAt,
    updatedAt: changes.at(-1)!.createdAt,
    status,
    actionCount: changes.length,
    affectedPaths: [...new Set(changes.flatMap((change) => change.paths.map((item) => item.path)))],
    changes,
  };
}
