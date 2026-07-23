import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, ".github", "assets", "agent-rewind-demo.gif");
const chrome =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const frames = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-demo-frames-"));
let browser;
let demo;
let demoExit;

try {
  await access(chrome);
  await mkdir(path.dirname(output), { recursive: true });
  demo = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "demo"], {
    cwd: root,
    env: { ...process.env, AGENT_REWIND_NO_BROWSER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  demoExit = new Promise((resolve) => demo.once("exit", resolve));
  let stdout = "";
  let stderr = "";
  demo.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  demo.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const url = await waitForMatch(
    () => stderr,
    /Agent Rewind approval UI: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/,
  );
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 1,
  });
  await page.goto(url[1]);
  await page.getByRole("button", { name: "Allow set" }).waitFor();

  let frame = 0;
  const capture = async (durationMs) => {
    const count = Math.ceil(durationMs / 250);
    for (let index = 0; index < count; index += 1) {
      await page.screenshot({
        path: path.join(frames, `frame-${String(frame++).padStart(4, "0")}.png`),
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  await capture(1_500);
  await page.getByRole("button", { name: "Allow set" }).hover();
  await capture(750);
  await page.getByRole("button", { name: "Allow set" }).click();
  await waitForMatch(() => stdout, /Scenario applied:/);
  await page.getByText("Organize project notes", { exact: true }).waitFor();
  await capture(2_000);
  await page.getByRole("button", { name: "Check undo" }).click();
  await page.locator(".readiness.ready").waitFor();
  await capture(2_000);
  await page.getByRole("button", { name: "Undo set" }).click();
  await page.locator(".status", { hasText: "undone" }).waitFor();
  await capture(2_000);

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "4",
      "-i",
      path.join(frames, "frame-%04d.png"),
      "-vf",
      "scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
      output,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  process.stdout.write(`Wrote ${output}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  if (demo && demo.exitCode === null && demo.signalCode === null) {
    demo.kill("SIGINT");
    await demoExit;
  }
  await rm(frames, { recursive: true, force: true });
}

async function waitForMatch(read, pattern, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = read().match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${pattern}`);
}
