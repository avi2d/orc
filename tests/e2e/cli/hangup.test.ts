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

const settleMs = 30_000;

const eventually = async <T>(probe: () => Promise<T | undefined>): Promise<T | undefined> => {
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const found = await probe();
    if (found !== undefined) return found;
    await Bun.sleep(100);
  }
  return undefined;
};

const readOr = async (path: string, fallback: string): Promise<string> => {
  try {
    return await Bun.file(path).text();
  } catch {
    return fallback;
  }
};

const childrenOf = async (pid: number): Promise<ReadonlyArray<number>> =>
  (await readOr(`/proc/${pid}/task/${pid}/children`, "")).split(" ").filter((field) => field !== "").map(Number);

// Matching the command line machine-wide picks up dashboards that parallel tests started, so only this terminal's descendants count.
const dashboardUnder = async (terminal: number): Promise<number | undefined> => {
  const pending = [...(await childrenOf(terminal))];
  for (let pid = pending.shift(); pid !== undefined; pid = pending.shift()) {
    if ((await readOr(`/proc/${pid}/cmdline`, "")) === `bun\0${command}\0`) return pid;
    pending.push(...(await childrenOf(pid)));
  }
  return undefined;
};

// The renderer writes its setup sequences before the screen watches stdin, so only a painted panel shows the dashboard is up.
const painted = async (screenFile: string): Promise<true | undefined> =>
  (await readOr(screenFile, "")).includes("quota") ? true : undefined;

type HangUp = (terminal: Bun.Subprocess, dashboard: number) => Promise<void>;

const exitCodeAfter = async (hangUp: HangUp): Promise<{ readonly gone: boolean; readonly code: string | undefined }> => {
  const home = mkdtempSync(join(tmpdir(), "orc-dash-hangup-e2e-"));
  const codeFile = join(home, "exit-code");
  const screenFile = join(home, "screen");
  const terminal = Bun.spawn(
    ["script", "-qfec", `trap '' HUP; bun '${command}'; echo -n $? > '${codeFile}'`, screenFile],
    {
      env: { PATH: process.env["PATH"] ?? "", HOME: home, TERM: process.env["TERM"] ?? "xterm-256color" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let dashboard: number | undefined;
  try {
    dashboard = await eventually(() => dashboardUnder(terminal.pid));
    if (dashboard === undefined) throw new Error("the dashboard never appeared under its pseudo terminal");
    if ((await eventually(() => painted(screenFile))) === undefined) throw new Error("the dashboard never drew to its pseudo terminal");
    await hangUp(terminal, dashboard);
    const running = dashboard;
    const gone = (await eventually(async () => (isRunning(running) ? undefined : true))) === true;
    return { gone, code: await eventually(async () => readOr(codeFile, "").then((code) => (code === "" ? undefined : code))) };
  } finally {
    if (dashboard !== undefined && isRunning(dashboard)) process.kill(dashboard, "SIGKILL");
    terminal.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
};

// Linux delivers the pty hangup SIGHUP only to the session leader, so the test sends SIGHUP itself.
describe("orc-dash on terminal hangup", () => {
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
