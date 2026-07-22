import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SERVER_NAME = "filesystem-with-rewind";

export function buildLaunchCommand(roots: string[]): string[] {
  return [
    "npm",
    "exec",
    "--yes",
    "--package=github:YanhanLi/agent-rewind",
    "--",
    "agent-rewind",
    ...roots,
  ];
}

export interface ConfigUpdateResult {
  filename: string;
  backup?: string;
  changed: boolean;
  config: Record<string, unknown>;
}

export interface UpdateOptions {
  filename?: string;
  dryRun?: boolean;
  now?: Date;
}

export async function persistConfigSource(
  filename: string,
  source: string,
  exists: boolean,
  options: UpdateOptions,
): Promise<string | undefined> {
  if (options.dryRun) return undefined;
  await mkdir(path.dirname(filename), { recursive: true });
  let backup: string | undefined;
  if (exists) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backup = `${filename}.backup-${stamp}`;
    await copyFile(filename, backup);
  }
  const temporary = path.join(
    path.dirname(filename),
    `.agent-rewind-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return backup;
}
