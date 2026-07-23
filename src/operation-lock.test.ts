import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SqliteOperationLock } from "./operation-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

it("serializes operations across independent lock instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-lock-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "operation-lock.sqlite");
  const first = new SqliteOperationLock(filename, 5);
  const second = new SqliteOperationLock(filename, 5);
  let active = 0;
  let maximumActive = 0;

  const operation = (delayMs: number) => async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
  };

  await Promise.all([first.run(operation(50)), second.run(operation(10))]);

  expect(maximumActive).toBe(1);
});

it("acquires normally after the previous SQLite owner disconnects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-lock-release-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "operation-lock.sqlite");
  const abandoned = new DatabaseSync(filename);
  abandoned.exec("BEGIN IMMEDIATE");
  abandoned.close();
  const lock = new SqliteOperationLock(filename, 5);
  let ran = false;

  await lock.run(async () => {
    ran = true;
  });

  expect(ran).toBe(true);
});
