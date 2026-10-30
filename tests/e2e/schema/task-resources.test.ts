import { describe, expect, test } from "bun:test";
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts";
import { macRusageReader } from "@tui-dash/schema";

describe("macRusageReader on this Mac", () => {
  test.skipIf(process.platform !== "darwin")(skipReason("proc_pid_rusage exists only on macOS", "reads the live and the zombie, names launchd unread, and gives a reaped pid no line"), async () => {
    const reaped = Bun.spawn(["true"]);
    await reaped.exited;
    const holder = Bun.spawn(["sh", "-c", "sleep 0 & exec sleep 5"]);
    const below = Bun.spawn(["sleep", "5"]);
    try {
      await Bun.sleep(300);
      const listed = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="]).stdout.toString();
      const zombie = listed
        .split("\n")
        .map((line) => line.trim().split(/ +/).map(Number))
        .find(([, ppid]) => ppid === holder.pid)?.[0];
      const pairs = [[1, 0], [process.pid, 1], [reaped.pid, process.pid], [below.pid, reaped.pid], [holder.pid, process.pid], [zombie ?? 0, holder.pid]];
      const run = Bun.spawnSync([process.execPath, "-e", macRusageReader, ...pairs.flat().map(String)]);
      const lines = run.stdout.toString().trim().split("\n");
      const named = lines.map((line) => line.split(" ").slice(0, 2).join(" "));
      expect(named).toContain("unread 1");
      expect(named).toContain("rusage " + String(zombie));
      expect(named.filter((line) => line.endsWith(" " + String(reaped.pid)))).toEqual([]);
      expect(named.indexOf("rusage " + String(process.pid))).toBeLessThan(named.indexOf("rusage " + String(below.pid)));
      expect(named.indexOf("rusage " + String(below.pid))).toBeGreaterThan(-1);
    } finally {
      holder.kill();
      below.kill();
    }
  });
});
