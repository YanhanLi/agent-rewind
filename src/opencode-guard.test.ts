import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectOpenCodeGuard,
  installOpenCodeGuard,
  openCodeGuardSource,
  uninstallOpenCodeGuard,
} from "./opencode-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-opencode-guard-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "plugins", "agent-rewind-guard.js");
}

describe("OpenCode guard", () => {
  it("blocks built-in edits while allowing MCP tools", async () => {
    const filename = await fixture();
    expect((await installOpenCodeGuard({ filename })).changed).toBe(true);
    expect((await installOpenCodeGuard({ filename })).changed).toBe(false);
    expect(await inspectOpenCodeGuard(filename)).toBe("configured");

    const encoded = Buffer.from(openCodeGuardSource()).toString("base64");
    const plugin = (await import(`data:text/javascript;base64,${encoded}`)) as {
      AgentRewindGuard: () => Promise<{
        "tool.execute.before": (input: { tool: string }) => Promise<void>;
      }>;
    };
    const hooks = await plugin.AgentRewindGuard();
    await expect(hooks["tool.execute.before"]({ tool: "apply_patch" })).rejects.toThrow(
      "Blocked by Agent Rewind guard",
    );
    await expect(
      hooks["tool.execute.before"]({ tool: "filesystem-with-rewind_edit_file" }),
    ).resolves.toBeUndefined();

    expect((await uninstallOpenCodeGuard({ filename })).changed).toBe(true);
    expect(await inspectOpenCodeGuard(filename)).toBe("missing");
  });

  it("refuses to overwrite or remove a foreign plugin", async () => {
    const filename = await fixture();
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "export const custom = true;\n");

    await expect(installOpenCodeGuard({ filename })).rejects.toThrow("Refusing to overwrite");
    await expect(uninstallOpenCodeGuard({ filename })).rejects.toThrow("Refusing to remove");
    expect(await readFile(filename, "utf8")).toContain("custom");
  });
});
