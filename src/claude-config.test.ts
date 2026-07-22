import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installClaudeConfig,
  inspectClaudeConfig,
  SERVER_NAME,
  uninstallClaudeConfig,
} from "./claude-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

async function fixture(source?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-claude-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "Claude", "claude_desktop_config.json");
  if (source !== undefined) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }
  return { directory, filename };
}

describe("Claude configuration", () => {
  it("preserves other settings, backs up, and writes atomically with private permissions", async () => {
    const original = `${JSON.stringify({ theme: "dark", mcpServers: { existing: { command: "old" } } }, null, 2)}\n`;
    const { filename } = await fixture(original);

    const result = await installClaudeConfig(["/tmp/project"], {
      filename,
      now: new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(result.changed).toBe(true);
    expect(await readFile(result.backup!, "utf8")).toBe(original);
    const written = JSON.parse(await readFile(filename, "utf8")) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.existing).toEqual({ command: "old" });
    expect(written.mcpServers[SERVER_NAME]).toBeDefined();
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect((await readdir(path.dirname(filename))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("is idempotent and uninstalls only the Agent Rewind entry", async () => {
    const { filename } = await fixture();
    await installClaudeConfig(["/tmp/project"], { filename });
    const second = await installClaudeConfig(["/tmp/project"], { filename });
    expect(second.changed).toBe(false);

    const removed = await uninstallClaudeConfig({ filename });
    expect(removed.changed).toBe(true);
    const config = JSON.parse(await readFile(filename, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers[SERVER_NAME]).toBeUndefined();
  });

  it("refuses invalid JSON without changing the file", async () => {
    const source = "{ invalid json\n";
    const { filename } = await fixture(source);

    await expect(installClaudeConfig(["/tmp/project"], { filename })).rejects.toThrow(
      "Refusing to modify invalid Claude configuration",
    );
    expect(await readFile(filename, "utf8")).toBe(source);
    expect(await inspectClaudeConfig(filename)).toBe("invalid");
  });

  it("returns the merged configuration without writing during dry-run", async () => {
    const { filename } = await fixture();
    const result = await installClaudeConfig(["/tmp/project"], { filename, dryRun: true });

    expect(result.changed).toBe(true);
    await expect(readFile(filename, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((result.config.mcpServers as Record<string, unknown>)[SERVER_NAME]).toBeDefined();
  });
});
