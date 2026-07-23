import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EntryState, PathChange } from "./model.js";

const MISSING_HASH = createHash("sha256").update("missing").digest("hex");

export class SnapshotStore {
  private totalBlobBytes = 0;
  private blobWriteTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly blobDirectory: string,
    private readonly limits = {
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 1024 * 1024 * 1024,
    },
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.blobDirectory, { recursive: true });
    await this.refreshTotalBlobBytes();
  }

  async garbageCollect(
    referencedBlobs: Set<string>,
    minimumUnreferencedAgeMs = 5 * 60 * 1_000,
  ): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - minimumUnreferencedAgeMs;
    for (const name of await readdir(this.blobDirectory)) {
      if (referencedBlobs.has(name)) continue;
      const filename = path.join(this.blobDirectory, name);
      const info = await lstat(filename);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await rm(filename);
      removed += 1;
    }
    await this.refreshTotalBlobBytes();
    return removed;
  }

  async readFileState(state: EntryState): Promise<Buffer | undefined> {
    if (state.kind === "missing") return Buffer.alloc(0);
    if (state.kind === "directory") return undefined;
    return readFile(path.join(this.blobDirectory, state.blob));
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
      if (content.byteLength > this.limits.maxFileBytes) {
        throw new Error(
          `Snapshot exceeds the per-file limit (${formatBytes(content.byteLength)} > ${formatBytes(this.limits.maxFileBytes)}): ${target}`,
        );
      }
      const hash = createHash("sha256").update(content).digest("hex");
      await this.ensureBlob(hash, content);
      return { kind: "file", hash, blob: hash, size: content.byteLength };
    }

    if (info.isDirectory()) {
      const names = (await readdir(target)).sort();
      const children: string[] = [];
      const manifest: Record<string, EntryState> = {};
      for (const name of names) {
        const child = await this.capture(path.join(target, name));
        children.push(`${name}:${child.kind}:${child.hash}`);
        manifest[name] = child;
      }
      const hash = createHash("sha256").update(children.join("\n")).digest("hex");
      return { kind: "directory", hash, entries: children, children: manifest };
    }

    throw new Error(`Unsupported filesystem entry: ${target}`);
  }

  async restore(change: PathChange): Promise<void> {
    await this.assertCurrent(change);

    if (change.before.kind === "missing") {
      await rm(change.path, { recursive: true, force: true });
      return;
    }

    if (change.before.kind === "file") {
      await mkdir(path.dirname(change.path), { recursive: true });
      await writeFile(change.path, await readFile(path.join(this.blobDirectory, change.before.blob)));
      return;
    }

    if (change.after.kind === "missing") {
      await this.validateDirectorySnapshot(change.before, change.path);
      await mkdir(path.dirname(change.path), { recursive: true });
      try {
        await mkdir(change.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await this.capture(change.path);
        throw new RewindConflictError(change.path, change.after.hash, current.hash);
      }
      await this.restoreDirectoryContents(change.path, change.before);
    }
  }

  async assertCurrent(change: PathChange): Promise<void> {
    const current = await this.capture(change.path);
    if (current.hash !== change.after.hash || current.kind !== change.after.kind) {
      throw new RewindConflictError(change.path, change.after.hash, current.hash);
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

  private async validateDirectorySnapshot(state: EntryState, target: string): Promise<void> {
    if (state.kind !== "directory" || !state.children) {
      throw new Error(`Directory snapshot is not restorable: ${target}`);
    }
    for (const [name, child] of Object.entries(state.children)) {
      validateChildName(name, target);
      if (child.kind === "file") {
        const blob = await lstat(path.join(this.blobDirectory, child.blob));
        if (!blob.isFile()) throw new Error(`Snapshot blob is not a file: ${child.blob}`);
      } else if (child.kind === "directory") {
        await this.validateDirectorySnapshot(child, path.join(target, name));
      } else {
        throw new Error(`Directory snapshot contains a missing child: ${path.join(target, name)}`);
      }
    }
  }

  private async restoreDirectoryContents(target: string, state: EntryState): Promise<void> {
    if (state.kind !== "directory" || !state.children) {
      throw new Error(`Directory snapshot is not restorable: ${target}`);
    }
    for (const [name, child] of Object.entries(state.children)) {
      const childTarget = path.join(target, name);
      if (child.kind === "file") {
        await writeFile(childTarget, await readFile(path.join(this.blobDirectory, child.blob)));
      } else if (child.kind === "directory") {
        await mkdir(childTarget);
        await this.restoreDirectoryContents(childTarget, child);
      }
    }
  }

  private async ensureBlob(hash: string, content: Buffer): Promise<void> {
    const result = this.blobWriteTail.then(async () => {
      const blob = path.join(this.blobDirectory, hash);
      try {
        await lstat(blob);
        const now = new Date();
        await utimes(blob, now, now);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      await this.refreshTotalBlobBytes();
      if (this.totalBlobBytes + content.byteLength > this.limits.maxTotalBytes) {
        throw new Error(`Snapshot storage quota exceeded (${formatBytes(this.limits.maxTotalBytes)}).`);
      }
      try {
        await writeFile(blob, content, { flag: "wx" });
        this.totalBlobBytes += content.byteLength;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const now = new Date();
        await utimes(blob, now, now);
        await this.refreshTotalBlobBytes();
      }
    });
    this.blobWriteTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshTotalBlobBytes(): Promise<void> {
    const sizes = await Promise.all(
      (await readdir(this.blobDirectory)).map(async (name) => {
        const info = await lstat(path.join(this.blobDirectory, name));
        return info.isFile() ? info.size : 0;
      }),
    );
    this.totalBlobBytes = sizes.reduce((total, size) => total + size, 0);
  }
}

function validateChildName(name: string, target: string): void {
  if (name.length === 0 || name === "." || name === ".." || path.basename(name) !== name) {
    throw new Error(`Invalid directory snapshot entry at ${target}`);
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
