import { DatabaseSync } from "node:sqlite";
import type { ChangeRecord } from "./model.js";

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
    return row ? (JSON.parse(row.payload) as ChangeRecord) : undefined;
  }

  list(limit = 50): ChangeRecord[] {
    const rows = this.database
      .prepare("SELECT payload FROM changes ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ChangeRecord);
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
      const record = JSON.parse(row.payload) as ChangeRecord;
      for (const change of record.paths) {
        if (change.before.kind === "file") blobs.add(change.before.blob);
        if (change.after.kind === "file") blobs.add(change.after.blob);
      }
    }
    return blobs;
  }
}
