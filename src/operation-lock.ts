import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export interface OperationLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export class SqliteOperationLock implements OperationLock {
  constructor(
    private readonly filename: string,
    private readonly retryMs = 25,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const database = await this.acquire();
    try {
      const result = await operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The connection may already have rolled back after a fatal SQLite error.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  private async acquire(): Promise<DatabaseSync> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    for (;;) {
      const database = new DatabaseSync(this.filename);
      database.exec("PRAGMA busy_timeout = 0");
      try {
        database.exec("BEGIN IMMEDIATE");
        return database;
      } catch (error) {
        database.close();
        if (!isBusy(error)) throw error;
        await delay(this.retryMs);
      }
    }
  }
}

function isBusy(error: unknown): boolean {
  const sqliteError = error as Error & { errcode?: number };
  return sqliteError.errcode === 5 || /database is (?:locked|busy)/i.test(sqliteError.message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
