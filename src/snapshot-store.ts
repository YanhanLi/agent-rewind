import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EntryState, PathChange } from "./model.js";

const MISSING_HASH = createHash("sha256").update("missing").digest("hex");

export class SnapshotStore {
  private totalBlobBytes = 0;

  constructor(
    private readonly blobDirectory: string,
    private readonly limits = {
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 1024 * 1024 * 1024,
    },
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.blobDirectory, { recursive: true });
    const blobs = await readdir(this.blobDirectory);
    const sizes = await Promise.all(
      blobs.map(async (name) => (await lstat(path.join(this.blobDirectory, name))).size),
    );
    this.totalBlobBytes = sizes.reduce((total, size) => total + size, 0);
  }

  async garbageCollect(referencedBlobs: Set<string>): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.blobDirectory)) {
      if (referencedBlobs.has(name)) continue;
      const filename = path.join(this.blobDirectory, name);
      const info = await lstat(filename);
      if (!info.isFile()) continue;
      await rm(filename);
      this.totalBlobBytes -= info.size;
      removed += 1;
    }
    return removed;
  }

  async capture(target: string): Promise<EntryState> {
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "missing", hash: MISSING_HASH };
      }
      throw error;
    }

    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported: ${target}`);
    }

    if (info.isFile()) {
      if (info.size > this.limits.maxFileBytes) {
        throw new Error(
          `Snapshot exceeds the per-file limit (${formatBytes(info.size)} > ${formatBytes(this.limits.maxFileBytes)}): ${target}`,
        );
      }
      const content = await readFile(target);
      const hash = createHash("sha256").update(content).digest("hex");
      const blob = path.join(this.blobDirectory, hash);
      try {
        await lstat(blob);
      } catch (lookupError) {
        if ((lookupError as NodeJS.ErrnoException).code !== "ENOENT") throw lookupError;
        if (this.totalBlobBytes + content.byteLength > this.limits.maxTotalBytes) {
          throw new Error(
            `Snapshot storage quota exceeded (${formatBytes(this.limits.maxTotalBytes)}).`,
          );
        }
        try {
          await writeFile(blob, content, { flag: "wx" });
          this.totalBlobBytes += content.byteLength;
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        }
      }
      return { kind: "file", hash, blob: hash, size: content.byteLength };
    }

    if (info.isDirectory()) {
      const names = (await readdir(target)).sort();
      const children: string[] = [];
      for (const name of names) {
        const child = await this.capture(path.join(target, name));
        children.push(`${name}:${child.kind}:${child.hash}`);
      }
      const hash = createHash("sha256").update(children.join("\n")).digest("hex");
      return { kind: "directory", hash, entries: children };
    }

    throw new Error(`Unsupported filesystem entry: ${target}`);
  }

  async restore(change: PathChange): Promise<void> {
    const current = await this.capture(change.path);
    if (current.hash !== change.after.hash || current.kind !== change.after.kind) {
      throw new RewindConflictError(change.path, change.after.hash, current.hash);
    }

    if (change.before.kind === "missing") {
      await rm(change.path, { recursive: true, force: true });
      return;
    }

    if (change.before.kind === "file") {
      await mkdir(path.dirname(change.path), { recursive: true });
      await writeFile(change.path, await readFile(path.join(this.blobDirectory, change.before.blob)));
      return;
    }

    // Directory contents are moved back by the move-specific inverse. Generic
    // restoration only removes a newly created empty directory safely.
    if (change.after.kind === "missing") {
      throw new Error(`Directory restoration requires a move inverse: ${change.path}`);
    }
  }

  async undoMove(source: PathChange, destination: PathChange): Promise<void> {
    const [currentSource, currentDestination] = await Promise.all([
      this.capture(source.path),
      this.capture(destination.path),
    ]);
    if (
      currentSource.hash !== source.after.hash ||
      currentDestination.hash !== destination.after.hash
    ) {
      throw new RewindConflictError(
        destination.path,
        destination.after.hash,
        currentDestination.hash,
      );
    }
    await mkdir(path.dirname(source.path), { recursive: true });
    await rename(destination.path, source.path);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export class RewindConflictError extends Error {
  constructor(
    readonly target: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`Refusing to overwrite a changed path: ${target}`);
    this.name = "RewindConflictError";
  }
}
