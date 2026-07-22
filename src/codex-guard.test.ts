import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectCodexGuard,
  installCodexGuard,
  uninstallCodexGuard,
} from "./codex-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

async function fixture(hooksSource?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-codex-guard-"));
  temporaryDirectories.push(directory);
  const hooksFilename = path.join(directory, ".codex", "hooks.json");
  const scriptFilename = path.join(directory, ".agent-rewind", "hooks", "codex-guard.mjs");
  if (hooksSource !== undefined) {
    await mkdir(path.dirname(hooksFilename), { recursive: true });
    await writeFile(hooksFilename, hooksSource);
  }
  return { hooksFilename, scriptFilename };
}

describe("Codex guard", () => {
  it("merges with existing hooks, blocks apply_patch, and uninstalls cleanly", async () => {
    const source = `{
  // Keep this hook.
  "hooks": {
    "PreToolUse": [{ "matcher": "^Bash$", "hooks": [] }]
  }
}
`;
    const files = await fixture(source);

    expect((await installCodexGuard(files)).changed).toBe(true);
    expect((await installCodexGuard(files)).changed).toBe(false);
    expect(await inspectCodexGuard(files)).toBe("configured");
    const installed = await readFile(files.hooksFilename, "utf8");
    expect(installed).toContain("// Keep this hook.");
    expect(installed).toContain("apply_patch");

    for (const toolName of ["apply_patch", "Edit", "Write"]) {
      const output = execFileSync(process.execPath, [files.scriptFilename], {
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName }),
      });
      expect(JSON.parse(output)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }

    expect((await uninstallCodexGuard(files)).changed).toBe(true);
    const removed = await readFile(files.hooksFilename, "utf8");
    expect(removed).toContain("// Keep this hook.");
    expect(removed).toContain("^Bash$");
    expect(removed).not.toContain("apply_patch");
    expect(await inspectCodexGuard(files)).toBe("missing");
  });

  it("refuses a modified script and malformed hooks", async () => {
    const modified = await fixture();
    await mkdir(path.dirname(modified.scriptFilename), { recursive: true });
    await writeFile(modified.scriptFilename, "// custom\n");
    await expect(installCodexGuard(modified)).rejects.toThrow("Refusing to overwrite");

    const malformed = await fixture("{ invalid\n");
    await expect(installCodexGuard(malformed)).rejects.toThrow("invalid Codex hooks");
  });

  it("produces a dry-run without creating files", async () => {
    const files = await fixture();
    const result = await installCodexGuard({ ...files, dryRun: true });

    expect(result.changed).toBe(true);
    await expect(readFile(files.hooksFilename, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(files.scriptFilename, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
