import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChangeIntent,
  ChangeRecord,
  ChangeSetPreview,
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
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY,
        change_set_id TEXT,
        change_set_label TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        recovered_at TEXT,
        reviewed_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        target TEXT
      );
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_created_at ON events (created_at)
    `);
    this.migrateLedger();
  }

  add(record: ChangeRecord): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.insertRecord(record);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  beginIntent(intent: ChangeIntent): void {
    this.database
      .prepare("INSERT INTO intents (id, created_at, payload) VALUES (?, ?, ?)")
      .run(intent.id, intent.createdAt, JSON.stringify(intent));
  }

  listIntents(): ChangeIntent[] {
    const rows = this.database
      .prepare("SELECT payload FROM intents ORDER BY created_at ASC")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ChangeIntent);
  }

  discardIntent(id: string): void {
    this.database.prepare("DELETE FROM intents WHERE id = ?").run(id);
  }

  close(): void {
    this.database.close();
  }

  finalizeIntent(intentId: string, record: ChangeRecord): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.insertRecord(record);
      this.database.prepare("DELETE FROM intents WHERE id = ?").run(intentId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  update(record: ChangeRecord): void {
    const existingRow = this.database.prepare("SELECT payload FROM changes WHERE id = ?").get(record.id) as
      | { payload: string }
      | undefined;
    if (!existingRow) return;
    const existing = parseRecord(existingRow.payload);
    if (
      existing.changeSetId !== record.changeSetId ||
      existing.createdAt !== record.createdAt ||
      existing.paths.length !== record.paths.length ||
      existing.paths.some((change, index) => change.path !== record.paths[index].path)
    ) {
      throw new Error("A ledger update cannot change a record's change set, creation time, or paths");
    }
    this.database
      .prepare(
        `UPDATE changes
         SET change_set_label = ?, status = ?, recovered_at = ?, reviewed_at = ?, payload = ?
         WHERE id = ?`,
      )
      .run(
        record.changeSetLabel ?? null,
        record.status,
        record.recoveredAt ?? null,
        record.reviewedAt ?? null,
        JSON.stringify(record),
        record.id,
      );
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
      recovery: {
        recovered: count("intent_recovered"),
        discarded: count("intent_discarded"),
        reviewed: count("recovery_reviewed"),
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
      .prepare("SELECT payload FROM changes ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as Array<{ payload: string }>;
    return rows.map((row) => parseRecord(row.payload));
  }

  listByChangeSet(changeSetId: string): ChangeRecord[] {
    const rows = this.database
      .prepare(
        `SELECT payload FROM changes
         WHERE change_set_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(changeSetId) as Array<{ payload: string }>;
    return rows.map((row) => parseRecord(row.payload));
  }

  markRecoveryReviewed(changeSetId: string, reviewedAt: string): ChangeSetView {
    const changes = this.listByChangeSet(changeSetId);
    if (changes.length === 0) throw new Error(`Unknown change set: ${changeSetId}`);
    if (!changes.some((change) => change.recoveredAt)) {
      throw new Error("This change set was not recovered after an interruption");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const change of changes) {
        if (!change.recoveredAt || change.reviewedAt) continue;
        this.update({ ...change, reviewedAt });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getChangeSet(changeSetId)!;
  }

  getChangeSet(changeSetId: string): ChangeSetView | undefined {
    const changes = this.listByChangeSet(changeSetId);
    return changes.length > 0 ? toChangeSet(changeSetId, changes) : undefined;
  }

  listChangeSets(limit = 20): ChangeSetView[] {
    const rows = this.database
      .prepare(
        `SELECT change_set_id
         FROM changes
         GROUP BY change_set_id
         ORDER BY MAX(created_at) DESC, MAX(rowid) DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ change_set_id: string }>;
    return rows.map(({ change_set_id: id }) => toChangeSet(id, this.listByChangeSet(id)));
  }

  listChangeSetPreviews(limit = 20, previewLimit = 5): ChangeSetPreview[] {
    const rows = this.database
      .prepare(
        `SELECT
           changes.change_set_id AS id,
           MIN(changes.created_at) AS created_at,
           MAX(changes.created_at) AS updated_at,
           COUNT(*) AS action_count,
           SUM(changes.status = 'applied') AS applied_count,
           SUM(changes.status = 'undone') AS undone_count,
           SUM(changes.status = 'conflict') AS conflict_count,
           SUM(changes.recovered_at IS NOT NULL) AS recovered_count,
           SUM(
             changes.recovered_at IS NOT NULL
             AND (changes.reviewed_at IS NOT NULL OR changes.status = 'undone')
           ) AS recovered_reviewed_count,
           (
             SELECT labelled.change_set_label
             FROM changes AS labelled
             WHERE labelled.change_set_id = changes.change_set_id
               AND labelled.change_set_label IS NOT NULL
             ORDER BY labelled.created_at ASC, labelled.rowid ASC
             LIMIT 1
           ) AS label
         FROM changes
         GROUP BY changes.change_set_id
         ORDER BY MAX(changes.created_at) DESC, MAX(changes.rowid) DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as ChangeSetPreviewRow[];

    const previewRecords = this.database.prepare(
      `SELECT payload FROM changes
       WHERE change_set_id = ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    );
    const previewPaths = this.database.prepare(
      `SELECT path, COUNT(*) OVER () AS path_count
       FROM change_set_paths
       WHERE change_set_id = ?
       ORDER BY first_created_at ASC, first_change_rowid ASC, first_position ASC
       LIMIT ?`,
    );

    return rows.map((row) => {
      const changes = (previewRecords.all(row.id, previewLimit) as Array<{ payload: string }>).map(
        ({ payload }) => parseRecord(payload),
      );
      const pathRows = previewPaths.all(
        row.id,
        previewLimit,
      ) as unknown as ChangeSetPreviewPathRow[];
      const affectedPathCount = Number(pathRows[0]?.path_count ?? 0);
      const actionCount = Number(row.action_count);
      return {
        id: row.id,
        label: row.label ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: previewStatus(row),
        recoveryStatus:
          Number(row.recovered_count) === 0
            ? undefined
            : Number(row.recovered_count) === Number(row.recovered_reviewed_count)
              ? "reviewed"
              : "pending",
        actionCount,
        affectedPathCount,
        affectedPaths: pathRows.map(({ path }) => path),
        changes,
        detailsTruncated:
          actionCount > changes.length || affectedPathCount > pathRows.length,
      };
    });
  }

  pruneBefore(cutoff: Date): number {
    const cutoffValue = cutoff.toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const affectedSets = this.database
        .prepare("SELECT DISTINCT change_set_id FROM changes WHERE created_at < ?")
        .all(cutoffValue) as Array<{ change_set_id: string }>;
      this.database
        .prepare(
          `DELETE FROM change_paths
           WHERE change_id IN (SELECT id FROM changes WHERE created_at < ?)`,
        )
        .run(cutoffValue);
      const changes = this.database
        .prepare("DELETE FROM changes WHERE created_at < ?")
        .run(cutoffValue);
      for (const { change_set_id: changeSetId } of affectedSets) {
        this.database
          .prepare("DELETE FROM change_set_paths WHERE change_set_id = ?")
          .run(changeSetId);
        this.rebuildChangeSetPaths(changeSetId);
      }
      this.database.prepare("DELETE FROM events WHERE created_at < ?").run(cutoffValue);
      this.database.exec("COMMIT");
      return Number(changes.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
    const intents = this.database.prepare("SELECT payload FROM intents").all() as Array<{
      payload: string;
    }>;
    for (const row of intents) {
      const intent = JSON.parse(row.payload) as ChangeIntent;
      for (const change of intent.paths) addEntryBlobs(change.before, blobs);
    }
    return blobs;
  }

  private allRecords(): ChangeRecord[] {
    const rows = this.database
      .prepare("SELECT payload FROM changes ORDER BY created_at ASC, rowid ASC")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => parseRecord(row.payload));
  }

  private insertRecord(record: ChangeRecord): void {
    const inserted = this.database
      .prepare(
        `INSERT INTO changes (
           id, change_set_id, change_set_label, created_at, status, recovered_at, reviewed_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.changeSetId,
        record.changeSetLabel ?? null,
        record.createdAt,
        record.status,
        record.recoveredAt ?? null,
        record.reviewedAt ?? null,
        JSON.stringify(record),
      );
    const changeRowId = Number(inserted.lastInsertRowid);
    const insertPath = this.database.prepare(
      "INSERT OR IGNORE INTO change_paths (change_id, path, position) VALUES (?, ?, ?)",
    );
    const insertChangeSetPath = this.database.prepare(
      `INSERT INTO change_set_paths (
         change_set_id, path, first_created_at, first_change_rowid, first_position
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (change_set_id, path) DO UPDATE SET
         first_created_at = CASE
           WHEN (excluded.first_created_at, excluded.first_change_rowid, excluded.first_position)
             < (first_created_at, first_change_rowid, first_position)
           THEN excluded.first_created_at ELSE first_created_at END,
         first_change_rowid = CASE
           WHEN (excluded.first_created_at, excluded.first_change_rowid, excluded.first_position)
             < (first_created_at, first_change_rowid, first_position)
           THEN excluded.first_change_rowid ELSE first_change_rowid END,
         first_position = CASE
           WHEN (excluded.first_created_at, excluded.first_change_rowid, excluded.first_position)
             < (first_created_at, first_change_rowid, first_position)
           THEN excluded.first_position ELSE first_position END`,
    );
    const seenPaths = new Set<string>();
    record.paths.forEach((change, position) => {
      if (seenPaths.has(change.path)) return;
      seenPaths.add(change.path);
      insertPath.run(record.id, change.path, position);
      insertChangeSetPath.run(
        record.changeSetId,
        change.path,
        record.createdAt,
        changeRowId,
        position,
      );
    });
  }

  private rebuildChangeSetPaths(changeSetId: string): void {
    this.database
      .prepare(
        `WITH ranked AS (
           SELECT
             changes.change_set_id,
             change_paths.path,
             changes.created_at,
             changes.rowid,
             change_paths.position,
             ROW_NUMBER() OVER (
               PARTITION BY changes.change_set_id, change_paths.path
               ORDER BY changes.created_at ASC, changes.rowid ASC, change_paths.position ASC
             ) AS occurrence_rank
           FROM changes
           JOIN change_paths ON change_paths.change_id = changes.id
           WHERE changes.change_set_id = ?
         )
         INSERT INTO change_set_paths (
           change_set_id, path, first_created_at, first_change_rowid, first_position
         )
         SELECT change_set_id, path, created_at, rowid, position
         FROM ranked
         WHERE occurrence_rank = 1`,
      )
      .run(changeSetId);
  }

  private migrateLedger(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.database.prepare("PRAGMA table_info(changes)").all() as Array<{
        name: string;
      }>;
      const columnNames = new Set(columns.map(({ name }) => name));
      if (!columns.some((column) => column.name === "change_set_id")) {
        this.database.exec("ALTER TABLE changes ADD COLUMN change_set_id TEXT");
      }
      if (!columnNames.has("change_set_label")) {
        this.database.exec("ALTER TABLE changes ADD COLUMN change_set_label TEXT");
        this.database.exec(
          "UPDATE changes SET change_set_label = json_extract(payload, '$.changeSetLabel')",
        );
      }
      if (!columnNames.has("recovered_at")) {
        this.database.exec("ALTER TABLE changes ADD COLUMN recovered_at TEXT");
        this.database.exec("UPDATE changes SET recovered_at = json_extract(payload, '$.recoveredAt')");
      }
      if (!columnNames.has("reviewed_at")) {
        this.database.exec("ALTER TABLE changes ADD COLUMN reviewed_at TEXT");
        this.database.exec("UPDATE changes SET reviewed_at = json_extract(payload, '$.reviewedAt')");
      }
      this.database.exec(`
        UPDATE changes
        SET change_set_id = COALESCE(json_extract(payload, '$.changeSetId'), id)
        WHERE change_set_id IS NULL
      `);
      const pathsTableExists = this.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'change_paths'")
        .get();
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS change_paths (
          change_id TEXT NOT NULL,
          path TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (change_id, path)
        )
      `);
      if (!pathsTableExists) {
        this.database.exec(`
          INSERT OR IGNORE INTO change_paths (change_id, path, position)
          SELECT changes.id, json_extract(item.value, '$.path'), CAST(item.key AS INTEGER)
          FROM changes, json_each(changes.payload, '$.paths') AS item
        `);
      }
      const changeSetPathsTableExists = this.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'change_set_paths'")
        .get();
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS change_set_paths (
          change_set_id TEXT NOT NULL,
          path TEXT NOT NULL,
          first_created_at TEXT NOT NULL,
          first_change_rowid INTEGER NOT NULL,
          first_position INTEGER NOT NULL,
          PRIMARY KEY (change_set_id, path)
        )
      `);
      if (!changeSetPathsTableExists) {
        this.database.exec(`
          WITH ranked AS (
            SELECT
              changes.change_set_id,
              change_paths.path,
              changes.created_at,
              changes.rowid,
              change_paths.position,
              ROW_NUMBER() OVER (
                PARTITION BY changes.change_set_id, change_paths.path
                ORDER BY changes.created_at ASC, changes.rowid ASC, change_paths.position ASC
              ) AS occurrence_rank
            FROM changes
            JOIN change_paths ON change_paths.change_id = changes.id
          )
          INSERT INTO change_set_paths (
            change_set_id, path, first_created_at, first_change_rowid, first_position
          )
          SELECT change_set_id, path, created_at, rowid, position
          FROM ranked
          WHERE occurrence_rank = 1
        `);
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS changes_change_set_created_at
        ON changes (change_set_id, created_at);
        CREATE INDEX IF NOT EXISTS change_paths_change_id
        ON change_paths (change_id);
        CREATE INDEX IF NOT EXISTS change_set_paths_order
        ON change_set_paths (
          change_set_id, first_created_at, first_change_rowid, first_position
        )
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

interface ChangeSetPreviewRow {
  id: string;
  label: string | null;
  created_at: string;
  updated_at: string;
  action_count: number;
  applied_count: number;
  undone_count: number;
  conflict_count: number;
  recovered_count: number;
  recovered_reviewed_count: number;
}

interface ChangeSetPreviewPathRow {
  path: string;
  path_count: number;
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

function previewStatus(row: ChangeSetPreviewRow): ChangeSetPreview["status"] {
  const actionCount = Number(row.action_count);
  if (Number(row.applied_count) === actionCount) return "applied";
  if (Number(row.undone_count) === actionCount) return "undone";
  if (Number(row.conflict_count) > 0) return "conflict";
  return "partial";
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
    recoveryStatus:
      changes.some((change) => change.recoveredAt)
        ? changes
            .filter((change) => change.recoveredAt)
            .every((change) => change.reviewedAt || change.status === "undone")
          ? "reviewed"
          : "pending"
        : undefined,
    actionCount: changes.length,
    affectedPaths: [...new Set(changes.flatMap((change) => change.paths.map((item) => item.path)))],
    changes,
  };
}
