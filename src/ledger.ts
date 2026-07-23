import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChangeRecord,
  ChangeSetView,
  LocalEvent,
  LocalEventType,
  ValidationReport,
  EntryState,
} from "./model.js";

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
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        target TEXT
      );
      CREATE INDEX IF NOT EXISTS events_created_at ON events (created_at)
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

  recordEvent(event: LocalEvent): void {
    this.database
      .prepare("INSERT INTO events (id, created_at, type, tool, target) VALUES (?, ?, ?, ?, ?)")
      .run(
        randomUUID(),
        new Date().toISOString(),
        event.type,
        event.tool ?? null,
        event.target ?? null,
      );
  }

  validationReport(): ValidationReport {
    const events = this.database
      .prepare("SELECT created_at, type, tool FROM events ORDER BY created_at ASC")
      .all() as Array<{ created_at: string; type: LocalEventType; tool: string | null }>;
    const records = this.allRecords();
    const count = (type: LocalEventType) => events.filter((event) => event.type === type).length;
    const tools: Record<string, number> = {};
    for (const event of events) {
      if (event.type === "change_applied" && event.tool) {
        tools[event.tool] = (tools[event.tool] ?? 0) + 1;
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      period: {
        firstEventAt: events.at(0)?.created_at ?? null,
        lastEventAt: events.at(-1)?.created_at ?? null,
      },
      approvals: {
        requested: count("approval_requested"),
        approved: count("approval_approved"),
        sessionApproved: count("approval_session_approved"),
        changeSetApproved: count("approval_change_set_approved"),
        autoApproved: count("approval_auto_approved"),
        rejected: count("approval_rejected"),
        expired: count("approval_expired"),
      },
      changes: {
        changeSets: new Set(records.map((record) => record.changeSetId)).size,
        actions: records.length,
        applied: records.filter((record) => record.status === "applied").length,
        undone: records.filter((record) => record.status === "undone").length,
        conflicts: records.filter((record) => record.status === "conflict").length,
      },
      undo: {
        attempted: count("undo_started"),
        succeeded: count("undo_succeeded"),
        conflicts: count("undo_conflict"),
      },
      tools: Object.fromEntries(
        Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
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
    return this.allRecords().filter((record) => record.changeSetId === changeSetId);
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
    const cutoffValue = cutoff.toISOString();
    const changes = this.database
      .prepare("DELETE FROM changes WHERE created_at < ?")
      .run(cutoffValue);
    this.database.prepare("DELETE FROM events WHERE created_at < ?").run(cutoffValue);
    return Number(changes.changes);
  }

  referencedBlobs(): Set<string> {
    const rows = this.database.prepare("SELECT payload FROM changes").all() as Array<{
      payload: string;
    }>;
    const blobs = new Set<string>();
    for (const row of rows) {
      const record = parseRecord(row.payload);
      for (const change of record.paths) {
        addEntryBlobs(change.before, blobs);
        addEntryBlobs(change.after, blobs);
      }
    }
    return blobs;
  }

  private allRecords(): ChangeRecord[] {
    const rows = this.database
      .prepare("SELECT payload FROM changes ORDER BY created_at ASC")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => parseRecord(row.payload));
  }
}

function addEntryBlobs(state: EntryState, blobs: Set<string>): void {
  if (state.kind === "file") {
    blobs.add(state.blob);
    return;
  }
  if (state.kind === "directory" && state.children) {
    for (const child of Object.values(state.children)) addEntryBlobs(child, blobs);
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
    label: changes.find((change) => change.changeSetLabel)?.changeSetLabel,
    createdAt: changes[0].createdAt,
    updatedAt: changes.at(-1)!.createdAt,
    status,
    actionCount: changes.length,
    affectedPaths: [...new Set(changes.flatMap((change) => change.paths.map((item) => item.path)))],
    changes,
  };
}
