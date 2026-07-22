import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_NAME } from "./claude-config.js";
import {
  installOpenCodeConfig,
  inspectOpenCodeConfig,
  uninstallOpenCodeConfig,
} from "./opencode-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

async function fixture(source?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-opencode-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "opencode.jsonc");
  if (source !== undefined) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }
  return { filename };
}

describe("OpenCode configuration", () => {
  it("preserves comments and unrelated settings while adding the MCP server", async () => {
    const source = `{
  // Keep this user preference.
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/test-model",
  "permission": { "edit": "ask" },
  "mcp": { "existing": { "type": "remote", "url": "https://example.test/mcp" } },
}
`;
    const { filename } = await fixture(source);

    const result = await installOpenCodeConfig(["/tmp/project"], {
      filename,
      now: new Date("2026-07-23T12:00:00.000Z"),
    });
    const written = await readFile(filename, "utf8");

    expect(result.changed).toBe(true);
    expect(await readFile(result.backup!, "utf8")).toBe(source);
    expect(written).toContain("// Keep this user preference.");
    expect(written).toContain('"model": "openai/test-model"');
    expect(written).toContain('"permission": { "edit": "ask" }');
    expect(result.config.mcp).toMatchObject({
      existing: { type: "remote" },
      [SERVER_NAME]: { type: "local", enabled: true, timeout: 120_000 },
    });
  });

  it("is idempotent and removes only its own entry", async () => {
    const { filename } = await fixture();
    await installOpenCodeConfig(["/tmp/project"], { filename });
    expect((await installOpenCodeConfig(["/tmp/project"], { filename })).changed).toBe(false);

    const removed = await uninstallOpenCodeConfig({ filename });
    expect(removed.changed).toBe(true);
    expect(removed.config.mcp).toEqual({});
    expect(await inspectOpenCodeConfig(filename)).toBe("missing");
  });

  it("refuses malformed JSONC without changing it", async () => {
    const source = "{ invalid: }\n";
    const { filename } = await fixture(source);

    await expect(installOpenCodeConfig(["/tmp/project"], { filename })).rejects.toThrow(
      "Refusing to modify invalid OpenCode configuration",
    );
    expect(await readFile(filename, "utf8")).toBe(source);
    expect(await inspectOpenCodeConfig(filename)).toBe("invalid");
  });

  it("returns the merged config without writing during dry-run", async () => {
    const { filename } = await fixture();
    const result = await installOpenCodeConfig(["/tmp/project"], { filename, dryRun: true });

    expect(result.changed).toBe(true);
    await expect(readFile(filename, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((result.config.mcp as Record<string, unknown>)[SERVER_NAME]).toBeDefined();
  });
});
