import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

const home = mkdtempSync(join(tmpdir(), "orc-dash-attention-dashboard-e2e-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const fakeOrc = (): string => {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "orc");
  const queue = join(root, "tests", "fixtures", "attention", "open.json");
  writeFileSync(script, `#!/bin/sh\n[ "$*" = "attention --json" ] || exit 2\ncat '${queue}'\n`);
  chmodSync(script, 0o755);
  return bin;
};

describe("orc-dash --print with the attention queue", () => {
  test("the default dashboard prints the open items the orc on the PATH answers, with the overdue mark", async () => {
    const child = Bun.spawn(["bun", join(root, "packages", "cli", "src", "bin.ts"), "--print", "--width", "120", "--height", "40"], {
      cwd: root,
      env: { PATH: `${fakeOrc()}:${process.env["PATH"] ?? ""}`, HOME: home, ORC_DASH_CONFIG: join(home, "absent.json") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain("3 open \u00b7 1 overdue");
    expect(stdout).toContain("! orc-1 \u00b7 user \u00b7 10m overdue");
  }, 120_000);
});
