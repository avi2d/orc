import { describe, expect, test } from "bun:test";
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeResourcesReport } from "@tui-dash/schema";
import { valueOf } from "../../lib/outcomes";

const root = join(import.meta.dir, "..", "..", "..");

const command = join(root, "packages", "cli", "src", "bin.ts");

const launchdPath = "/usr/bin:/bin:/usr/sbin:/sbin";

const tasksReport = (folder: string) => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  orchestrator: { name: "harbor", version: "0.9.0" },
  tasks: [
    {
      id: "build",
      title: "Build",
      project: "harbor",
      kind: "build",
      state: "working",
      detail: "Building",
      startedAt: "2026-01-01T00:00:00.000Z",
      firstStartedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      folders: [folder],
      branches: [],
    },
  ],
  overhead: [],
  schedules: [],
});

describe("tui-dash report resources under a user service's PATH on the Mac", () => {
  test.skipIf(process.platform !== "darwin")(skipReason("launchd's PATH and the bun-less collector exist only on macOS", "reads the task's live process with no bun on the PATH"), async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "tui-dash-tasks-path-")));
    const sleeper = Bun.spawn(["sleep", "30"], { cwd: folder });
    try {
      const report = join(folder, "tasks.json");
      writeFileSync(report, JSON.stringify(tasksReport(folder)));
      const child = Bun.spawn([process.execPath, command, "report", "resources"], {
        env: { PATH: launchdPath, HOME: process.env["HOME"] ?? "", TUI_DASH_TASKS: `cat '${report}'` },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      const { tasks } = valueOf(decodeResourcesReport(stdout));
      expect(tasks?.kind === "ok" ? tasks.value.map(({ id, processes }) => [id, processes]) : tasks).toEqual([["build", 1]]);
    } finally {
      sleeper.kill();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
