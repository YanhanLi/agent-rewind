import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EntryState, PathChange } from "./model.js";

const MISSING_HASH = createHash("sha256").update("missing").digest("hex");
const STAGING_MARKER = ".agent-rewind-staging.json";

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
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    const handle = await open(
      this.blobDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) {
        throw new Error(`Snapshot path is not a directory: ${this.blobDirectory}`);
      }
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
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
    return this.readVerifiedBlob(state);
  }

  async capture(target: string): Promise<EntryState> {
    return this.captureState(target, true);
  }

  async inspect(target: string): Promise<EntryState> {
    return this.captureState(target, false);
  }

  async captureForRecord(target: string): Promise<EntryState> {
    try {
      return await this.captureState(target, true);
    } catch (error) {
      if (!(error instanceof SnapshotStorageError)) throw error;
      return this.captureState(target, false);
    }
  }

  async verifySnapshot(state: EntryState, target: string): Promise<void> {
    if (state.kind === "missing") return;
    if (state.kind === "file") {
      await this.readVerifiedBlob(state);
      return;
    }
    this.validateDirectorySnapshot(state, target);
    await this.verifyDirectoryBlobs(state, target);
  }

  private async captureState(target: string, persistFiles: boolean): Promise<EntryState> {
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
      return persistFiles ? this.captureFile(target) : inspectFile(target);
    }

    if (info.isDirectory()) {
      const names = (await readdir(target)).sort();
      const children: string[] = [];
      const manifest: Record<string, EntryState> = {};
      for (const name of names) {
        const child = await this.captureState(path.join(target, name), persistFiles);
        children.push(`${name}:${child.kind}:${child.hash}`);
        manifest[name] = child;
      }
      const hash = createHash("sha256").update(children.join("\n")).digest("hex");
      return { kind: "directory", hash, entries: children, children: manifest };
    }

    throw new Error(`Unsupported filesystem entry: ${target}`);
  }

  async restore(change: PathChange): Promise<void> {
    await this.cleanupRestoreStaging(change.path);
    if (!(await this.restoreIsPending(change))) return;

    if (change.before.kind === "missing") {
      const stagingDirectory = await this.createStagingDirectory(change.path);
      try {
        if (!(await this.restoreIsPending(change))) return;
        await rename(change.path, path.join(stagingDirectory, "entry"));
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
      return;
    }

    if (change.before.kind === "file") {
      const content = await this.readVerifiedBlob(change.before);
      const stagingDirectory = await this.createStagingDirectory(change.path);
      const stagedFile = path.join(stagingDirectory, "file");
      try {
        await writeFile(stagedFile, content, { flag: "wx" });
        if (!(await this.restoreIsPending(change))) return;
        if (change.after.kind === "missing") {
          try {
            await link(stagedFile, change.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (await this.restoreIsPending(change)) {
              throw new Error(`Atomic restore could not create ${change.path}`);
            }
          }
        } else {
          await rename(stagedFile, change.path);
        }
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
      return;
    }

    if (change.after.kind === "missing") {
      this.validateDirectorySnapshot(change.before, change.path);
      const stagingDirectory = await this.createStagingDirectory(change.path);
      const stagedRoot = path.join(stagingDirectory, "directory");
      try {
        await mkdir(stagedRoot);
        await this.restoreDirectoryContents(stagedRoot, change.before);
        if (!(await this.restoreIsPending(change))) return;
        try {
          await rename(stagedRoot, change.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
          if (await this.restoreIsPending(change)) {
            throw new Error(`Atomic restore could not create ${change.path}`);
          }
        }
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    }
  }

  async assertCurrent(change: PathChange): Promise<void> {
    const current = await this.inspect(change.path);
    if (current.hash !== change.after.hash || current.kind !== change.after.kind) {
      throw new RewindConflictError(change.path, change.after.hash, current.hash);
    }
  }

  private async restoreIsPending(change: PathChange): Promise<boolean> {
    const current = await this.inspect(change.path);
    if (statesMatch(current, change.before)) return false;
    if (!statesMatch(current, change.after)) {
      throw new RewindConflictError(change.path, change.after.hash, current.hash);
    }
    return true;
  }

  private async createStagingDirectory(target: string): Promise<string> {
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const stagingDirectory = await mkdtemp(path.join(parent, restoreStagingPrefix(target)));
    try {
      await writeFile(
        path.join(stagingDirectory, STAGING_MARKER),
        JSON.stringify({ version: 1, target: path.resolve(target) }),
        { flag: "wx", mode: 0o600 },
      );
      return stagingDirectory;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async cleanupRestoreStaging(target: string): Promise<void> {
    const parent = path.dirname(target);
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const prefix = restoreStagingPrefix(target);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const candidate = path.join(parent, entry.name);
      if (!(await this.isOwnedStagingDirectory(candidate, target))) continue;
      await rm(candidate, { recursive: true, force: true });
    }
  }

  private async isOwnedStagingDirectory(directory: string, target: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        path.join(directory, STAGING_MARKER),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) return false;
      const marker = JSON.parse(await handle.readFile("utf8")) as {
        version?: unknown;
        target?: unknown;
      };
      return marker.version === 1 && marker.target === path.resolve(target);
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  async undoMove(source: PathChange, destination: PathChange): Promise<void> {
    const [currentSource, currentDestination] = await Promise.all([
      this.inspect(source.path),
      this.inspect(destination.path),
    ]);
    if (
      statesMatch(currentSource, source.before) &&
      statesMatch(currentDestination, destination.before)
    ) {
      return;
    }
    if (
      !statesMatch(currentSource, source.after) ||
      !statesMatch(currentDestination, destination.after)
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

  private validateDirectorySnapshot(state: EntryState, target: string): void {
    if (state.kind !== "directory" || !state.children) {
      throw new Error(`Directory snapshot is not restorable: ${target}`);
    }
    const entries: string[] = [];
    const children = Object.entries(state.children).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [name, child] of children) {
      validateChildName(name, target);
      entries.push(`${name}:${child.kind}:${child.hash}`);
      if (child.kind === "directory") {
        this.validateDirectorySnapshot(child, path.join(target, name));
      } else if (child.kind === "missing") {
        throw new Error(`Directory snapshot contains a missing child: ${path.join(target, name)}`);
      }
    }
    const actualHash = createHash("sha256").update(entries.join("\n")).digest("hex");
    if (actualHash !== state.hash) {
      throw new SnapshotIntegrityError(`Directory snapshot hash mismatch: ${target}`);
    }
  }

  private async restoreDirectoryContents(target: string, state: EntryState): Promise<void> {
    if (state.kind !== "directory" || !state.children) {
      throw new Error(`Directory snapshot is not restorable: ${target}`);
    }
    for (const [name, child] of Object.entries(state.children)) {
      const childTarget = path.join(target, name);
      if (child.kind === "file") {
        await writeFile(childTarget, await this.readVerifiedBlob(child), { flag: "wx" });
      } else if (child.kind === "directory") {
        await mkdir(childTarget);
        await this.restoreDirectoryContents(childTarget, child);
      }
    }
  }

  private async verifyDirectoryBlobs(state: EntryState, target: string): Promise<void> {
    if (state.kind !== "directory" || !state.children) {
      throw new Error(`Directory snapshot is not restorable: ${target}`);
    }
    for (const [name, child] of Object.entries(state.children)) {
      if (child.kind === "file") {
        await this.readVerifiedBlob(child);
      } else if (child.kind === "directory") {
        await this.verifyDirectoryBlobs(child, path.join(target, name));
      }
    }
  }

  private async readVerifiedBlob(state: Extract<EntryState, { kind: "file" }>): Promise<Buffer> {
    if (state.blob !== state.hash || path.basename(state.blob) !== state.blob) {
      throw new SnapshotIntegrityError(`Invalid content-addressed snapshot blob: ${state.blob}`);
    }
    const filename = path.join(this.blobDirectory, state.blob);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new SnapshotIntegrityError(`Snapshot blob is not a file: ${state.blob}`);
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      assertStableFile(before, after, filename);
      const actualHash = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== state.size || actualHash !== state.hash) {
        throw new SnapshotIntegrityError(`Snapshot blob failed verification: ${state.blob}`);
      }
      return content;
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) throw error;
      throw new SnapshotIntegrityError(
        `Snapshot blob could not be read safely: ${state.blob}`,
        error,
      );
    } finally {
      await handle?.close();
    }
  }

  private async ensureBlob(hash: string, content: Buffer): Promise<void> {
    const result = this.blobWriteTail.then(async () => {
      const blob = path.join(this.blobDirectory, hash);
      const state = { kind: "file" as const, hash, blob: hash, size: content.byteLength };
      try {
        await lstat(blob);
        try {
          await this.readVerifiedBlob(state);
          const now = new Date();
          await utimes(blob, now, now);
        } catch (error) {
          if (!(error instanceof SnapshotIntegrityError)) throw error;
          await this.replaceCorruptedBlob(hash, content);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      await this.refreshTotalBlobBytes();
      if (this.totalBlobBytes + content.byteLength > this.limits.maxTotalBytes) {
        throw new SnapshotStorageError(
          `Snapshot storage quota exceeded (${formatBytes(this.limits.maxTotalBytes)}).`,
        );
      }
      try {
        await writeFile(blob, content, { flag: "wx", mode: 0o600 });
        this.totalBlobBytes += content.byteLength;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          await this.readVerifiedBlob(state);
          const now = new Date();
          await utimes(blob, now, now);
          await this.refreshTotalBlobBytes();
        } catch (existingError) {
          if (!(existingError instanceof SnapshotIntegrityError)) throw existingError;
          await this.replaceCorruptedBlob(hash, content);
        }
      }
    });
    this.blobWriteTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async replaceCorruptedBlob(hash: string, content: Buffer): Promise<void> {
    const blob = path.join(this.blobDirectory, hash);
    let replacedBytes = 0;
    try {
      const existing = await lstat(blob);
      if (existing.isDirectory()) {
        throw new SnapshotIntegrityError(
          `Snapshot blob repair refused to replace a directory: ${hash}`,
        );
      }
      if (existing.isFile()) replacedBytes = existing.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await this.refreshTotalBlobBytes();
    if (this.totalBlobBytes - replacedBytes + content.byteLength > this.limits.maxTotalBytes) {
      throw new SnapshotStorageError(
        `Snapshot storage quota exceeded (${formatBytes(this.limits.maxTotalBytes)}).`,
      );
    }

    const temporary = path.join(this.blobDirectory, `.${hash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, blob);
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) throw error;
      throw new SnapshotIntegrityError(
        `Snapshot blob could not be repaired safely: ${hash}`,
        error,
      );
    } finally {
      await rm(temporary, { force: true });
    }
    await this.refreshTotalBlobBytes();
  }

  private async captureFile(target: string): Promise<EntryState> {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`Unsupported filesystem entry: ${target}`);
      if (before.size > this.limits.maxFileBytes) {
        throw new SnapshotStorageError(
          `Snapshot exceeds the per-file limit (${formatBytes(before.size)} > ${formatBytes(this.limits.maxFileBytes)}): ${target}`,
        );
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      assertStableFile(before, after, target);
      if (content.byteLength > this.limits.maxFileBytes) {
        throw new SnapshotStorageError(
          `Snapshot exceeds the per-file limit (${formatBytes(content.byteLength)} > ${formatBytes(this.limits.maxFileBytes)}): ${target}`,
        );
      }
      const hash = createHash("sha256").update(content).digest("hex");
      await this.ensureBlob(hash, content);
      return { kind: "file", hash, blob: hash, size: content.byteLength };
    } finally {
      await handle.close();
    }
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

async function inspectFile(target: string): Promise<EntryState> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Unsupported filesystem entry: ${target}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const content = chunk as Buffer;
      hash.update(content);
      size += content.byteLength;
    }
    const after = await handle.stat();
    assertStableFile(before, after, target);
    const digest = hash.digest("hex");
    return { kind: "file", hash: digest, blob: digest, size };
  } finally {
    await handle.close();
  }
}

function assertStableFile(
  before: Stats,
  after: Stats,
  target: string,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`File changed while it was being snapshotted: ${target}`);
  }
}

function statesMatch(left: EntryState, right: EntryState): boolean {
  return left.kind === right.kind && left.hash === right.hash;
}

function restoreStagingPrefix(target: string): string {
  const targetHash = createHash("sha256").update(path.resolve(target)).digest("hex").slice(0, 16);
  return `.agent-rewind-restore-${targetHash}-`;
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

export class SnapshotIntegrityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SnapshotIntegrityError";
  }
}

class SnapshotStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotStorageError";
  }
}
