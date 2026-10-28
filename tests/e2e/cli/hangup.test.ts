import { describe, expect, test } from "bun:test";
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

const command = join(root, "packages", "cli", "src", "bin.ts");

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const dashboardPids = async (): Promise<ReadonlySet<number>> => {
  const listing = Bun.spawn(["pgrep", "-xf", `bun ${command}`], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(listing.stdout).text();
  await listing.exited;
  return new Set(out.split("\n").filter((line) => line !== "").map(Number));
};

const dashboardUnder = async (before: ReadonlySet<number>): Promise<number> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const pid of await dashboardPids()) {
      if (!before.has(pid)) return pid;
    }
    await Bun.sleep(100);
  }
  throw new Error("the dashboard never appeared under its pseudo terminal");
};

const waitsGone = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isRunning(pid)) return true;
    await Bun.sleep(100);
  }
  return false;
};

const recordedCode = async (codeFile: string): Promise<string | undefined> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await Bun.file(codeFile).text();
    } catch {
      await Bun.sleep(100);
    }
  }
  return undefined;
};

type HangUp = (terminal: Bun.Subprocess, dashboard: number) => Promise<void>;

const exitCodeAfter = async (hangUp: HangUp): Promise<{ readonly gone: boolean; readonly code: string | undefined }> => {
  const home = mkdtempSync(join(tmpdir(), "tui-dash-hangup-e2e-"));
  const codeFile = join(home, "exit-code");
  try {
    const before = await dashboardPids();
    const terminal = Bun.spawn(
      ["script", "-qec", `trap '' HUP; bun '${command}'; echo -n $? > '${codeFile}'`, "/dev/null"],
      {
        env: { PATH: process.env["PATH"] ?? "", HOME: home, TERM: process.env["TERM"] ?? "xterm-256color" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let dashboard: number | undefined;
    try {
      dashboard = await dashboardUnder(before);
      await Bun.sleep(4000);
      await hangUp(terminal, dashboard);
      const gone = await waitsGone(dashboard);
      return { gone, code: await recordedCode(codeFile) };
    } finally {
      if (dashboard !== undefined && isRunning(dashboard)) process.kill(dashboard, "SIGKILL");
      terminal.kill("SIGKILL");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

// Linux delivers the pty hangup SIGHUP only to the session leader, so the test sends SIGHUP itself.
describe("tui-dash on terminal hangup", () => {
  test.skipIf(process.platform !== "linux")(skipReason("needs util-linux script -c and Linux pty hangup semantics", "losing its pseudo terminal exits the dashboard with code 0 within a few seconds", "local"), async () => {
    const outcome = await exitCodeAfter(async (terminal) => {
      terminal.kill("SIGKILL");
      await terminal.exited;
    });
    expect(outcome).toEqual({ gone: true, code: "0" });
  }, 60_000);

  test.skipIf(process.platform !== "linux")(skipReason("needs util-linux script -c and Linux pty hangup semantics", "SIGHUP with its pseudo terminal still open exits the dashboard with code 0 within a few seconds", "local"), async () => {
    const outcome = await exitCodeAfter(async (_terminal, dashboard) => {
      process.kill(dashboard, "SIGHUP");
    });
    expect(outcome).toEqual({ gone: true, code: "0" });
  }, 60_000);
});
