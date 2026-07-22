import { describe, expect, it } from "vitest";
import { SERVER_NAME } from "./claude-config.js";
import {
  buildCodexConfigFragment,
  inspectCodexConfig,
  installCodexConfig,
  type CodexRunner,
  uninstallCodexConfig,
} from "./codex-config.js";

function fixture(initialArgs?: string[]) {
  let args = initialArgs;
  const calls: string[][] = [];
  const run: CodexRunner = async (command) => {
    calls.push(command);
    if (command[0] === "mcp" && command[1] === "get") {
      if (!args) throw { stderr: `Error: No MCP server named '${SERVER_NAME}' found.` };
      return JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        transport: { type: "stdio", command: "npm", args },
      });
    }
    if (command[0] === "mcp" && command[1] === "add") {
      const separator = command.indexOf("--");
      expect(separator).toBeGreaterThan(0);
      expect(command[2]).toBe(SERVER_NAME);
      expect(command[separator + 1]).toBe("npm");
      args = command.slice(separator + 2);
      return "added";
    }
    if (command[0] === "mcp" && command[1] === "remove") {
      args = undefined;
      return "removed";
    }
    throw new Error(`Unexpected command: ${command.join(" ")}`);
  };
  return { run, calls };
}

describe("Codex configuration", () => {
  it("uses the official Codex CLI and remains idempotent", async () => {
    const { run, calls } = fixture();

    expect((await installCodexConfig(["/tmp/project"], { run })).changed).toBe(true);
    expect((await installCodexConfig(["/tmp/project"], { run })).changed).toBe(false);
    expect(await inspectCodexConfig({ run })).toBe("configured");
    expect((await uninstallCodexConfig({ run })).changed).toBe(true);
    expect((await uninstallCodexConfig({ run })).changed).toBe(false);
    expect(calls.some((call) => call.slice(0, 3).join(" ") === `mcp add ${SERVER_NAME}`)).toBe(true);
  });

  it("refuses to overwrite a different same-name entry", async () => {
    const { run } = fixture(["exec", "something-else"]);

    await expect(installCodexConfig(["/tmp/project"], { run })).rejects.toThrow(
      "already has a different",
    );
  });

  it("generates a valid-looking TOML fragment without invoking Codex for dry-run", async () => {
    const run: CodexRunner = async () => {
      throw new Error("must not run");
    };
    const result = await installCodexConfig(["/tmp/project with space"], { run, dryRun: true });
    const fragment = buildCodexConfigFragment(["/tmp/project with space"]);

    expect(result.changed).toBe(true);
    expect(fragment).toContain(`[mcp_servers.${SERVER_NAME}]`);
    expect(fragment).toContain('"/tmp/project with space"');
  });

  it("reports a missing Codex executable", async () => {
    const run: CodexRunner = async () => {
      throw { code: "ENOENT" };
    };
    expect(await inspectCodexConfig({ run })).toBe("unavailable");
  });
});
