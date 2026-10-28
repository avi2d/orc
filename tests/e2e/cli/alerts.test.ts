import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { AlertEvent } from "@tui-dash/schema";

const root = join(import.meta.dir, "..", "..", "..");

const command = join(root, "packages", "cli", "src", "bin.ts");

const recordedTasks = join(root, "tests", "fixtures", "tasks", "east.json");

const home = mkdtempSync(join(tmpdir(), "tui-dash-alerts-e2e-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const settingsFile = (name: string, settings: unknown): string => {
  const path = join(home, name);
  writeFileSync(path, JSON.stringify({ panels: { alerts: settings } }));
  return path;
};

const environment = (settings: string) => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  TUI_DASH_MACHINE: "north",
  TUI_DASH_CONFIG: settings,
  TUI_DASH_TASKS: `cat '${recordedTasks}'`,
});

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(AlertEvent));

// Reads the stream's lines until it holds what the test waits for, then stops the command as a listener would.
const eventsUntil = async (settings: string, enough: (events: ReadonlyArray<AlertEvent>) => boolean): Promise<ReadonlyArray<AlertEvent>> => {
  const child = Bun.spawn(["bun", command, "alerts", "--json"], { env: environment(settings), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill(), 20_000);
  const events: Array<AlertEvent> = [];
  let pending = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      events.push(...lines.filter((line) => line !== "").map((line) => decodeEvent(line)));
      if (enough(events)) break;
    }
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
  if (!enough(events)) throw new Error(`the stream stopped short after ${JSON.stringify(events)}, with stderr: ${await stderr}`);
  return events;
};

describe("tui-dash alerts --json", () => {
  test("prints a heavy load event for this machine and a total event for each live recorded task", async () => {
    const settings = settingsFile("low.json", {
      heavyLoad: { everySeconds: 0.2, sustainedMinutes: 0.001, machines: [{ name: "north", loadAtLeast: 1000, memory: { usedAtLeastPercent: 0.001 } }] },
      longTask: { everySeconds: 0.2, totalHours: 0.001 },
    });
    const events = await eventsUntil(settings, (seen) => seen.filter((event) => event.rule !== "quota-pace").length >= 3);
    const heavy = events.find((event) => event.rule === "heavy-load");
    expect(heavy?.rule === "heavy-load" ? [heavy.machine, heavy.crossed, heavy.topProcesses.byCpu.length > 0] : heavy).toEqual(["north", ["memory"], true]);
    expect(events.flatMap((event) => (event.rule === "long-task" ? [[event.reason, event.task.id]] : []))).toEqual([
      ["total", "tasks-bridge-plot"],
      ["total", "tasks-inbox-sweep"],
    ]);
  }, 30_000);

  // POSIX keeps a trapped TERM ignored in the command's children.
  test("stopping the stream leaves no tasks command running, even one that ignores SIGTERM", async () => {
    const pids = join(home, "hung-pids");
    const child = Bun.spawn(["bun", command, "alerts", "--json"], {
      env: { ...environment(join(home, "absent.json")), TUI_DASH_TASKS: `trap "" TERM INT HUP; sleep 6003 & echo $! >> '${pids}'; wait` },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let attempt = 0; attempt < 250 && !(await Bun.file(pids).exists()); attempt += 1) await Bun.sleep(20);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
    const sleepers = (await Bun.file(pids).text()).split("\n").filter((line) => line !== "").map(Number);
    await Bun.sleep(200);
    expect(sleepers.length).toBeGreaterThan(0);
    expect(sleepers.filter((pid) => isRunning(pid))).toEqual([]);
  }, 30_000);

  test("refuses a settings file it cannot read and names its path", async () => {
    const settings = settingsFile("typo.json", { heavyLoad: { sustainedMinute: 1 } });
    const child = Bun.spawn(["bun", command, "alerts", "--json"], { env: environment(settings), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain(`panels.alerts in ${settings} is not valid`);
    expect(stdout + stderr).toContain("sustainedMinute");
  });

  test("refuses to run without --json", async () => {
    const child = Bun.spawn(["bun", command, "alerts"], { env: environment(join(home, "absent.json")), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("--json");
  });

  test("files one fix task for a red night workflow and none again for the same run", async () => {
    const bin = join(home, "nightly-bin");
    await Bun.write(join(home, "runner.json"), JSON.stringify({ agentId: 1, agentName: "north-1", poolId: 1, gitHubUrl: "https://github.com/example/website", workFolder: "_work" }));
    const workflow = ["name: night-run", "on:", "  schedule:", "    - cron: \"1 3 * * *\"", ""].join("\n");
    const gh = [
      "#!/bin/sh",
      "case \"$*\" in",
      "  */runs/*/jobs*) echo '{\"jobs\": []}';;",
      "  *actions/runs[?]*) echo '{\"workflow_runs\": [{\"id\": 101, \"name\": \"night-run\", \"head_branch\": \"main\", \"status\": \"completed\", \"conclusion\": \"failure\", \"created_at\": \"2026-10-27T03:05:00Z\", \"updated_at\": \"2026-10-27T03:20:00Z\"}]}';;",
      "  *actions/workflows[?]*) echo '{\"workflows\": []}';;",
      "  *night-run.yml*) echo '{\"content\": \"CONTENT\", \"encoding\": \"base64\"}';;",
      "  *contents/.github/workflows*) echo '[{\"path\": \".github/workflows/night-run.yml\", \"type\": \"file\"}]';;",
      "  *) echo \"unexpected $*\" >&2; exit 1;;",
      "esac",
""].join("\n");
    await Bun.write(join(home, "nightly-gh.sh"), gh.replace("CONTENT", Buffer.from(workflow).toString("base64")));
    await Bun.$`mkdir -p ${bin} && cp ${join(home, "nightly-gh.sh")} ${join(bin, "gh")} && chmod +x ${join(bin, "gh")}`;
    const settings = settingsFile("nightly.json", { nightly: { everySeconds: 0.2, homes: { "example/website": "my-website" } } });
    const child = Bun.spawn(["bun", command, "alerts", "--json"], {
      env: { ...environment(settings), TUI_DASH_RUNNERS: "cat \"" + join(home, "runner.json") + "\"", PATH: bin + ":" + (process.env["PATH"] ?? "") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 25_000);
    const seen: Array<AlertEvent> = [];
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        seen.push(...lines.filter((line) => line !== "").map((line) => decodeEvent(line)));
        if (seen.some((event) => event.rule === "nightly")) break;
      }
      await Bun.sleep(1000);
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
    }
    pending += decoder.decode();
    seen.push(...pending.split("\n").filter((line) => line !== "").map((line) => decodeEvent(line)));
    const filed = seen.filter((event) => event.rule === "nightly");
    expect(filed).toHaveLength(1);
    const task = filed[0];
    expect([task.repo, task.workflow, task.runId, task.conclusion, task.home]).toEqual(["example/website", "night-run", 101, "failure", "my-website"]);
    const at = new Date(task.at);
    const recheck = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 3, 1));
    if (recheck.getTime() <= at.getTime()) recheck.setUTCDate(recheck.getUTCDate() + 1);
    expect(task.recheckAt).toBe(recheck.toISOString());
  }, 30_000);
});