import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

const bins = ["packages/cli/src/bin.ts", "packages/session-quota/src/capture-bin.ts"];

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (bin: string, args: ReadonlyArray<string>): Promise<Ran> => {
  const child = Bun.spawn(["bun", join(root, bin), ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
    ([code, stdout, stderr]) => ({ code, stdout, stderr }),
  );
  const timedOut = Bun.sleep(15000).then(() => undefined);
  const result = await Promise.race([finished, timedOut]);
  if (result === undefined) {
    child.kill("SIGKILL");
    throw new Error(bin + " " + args.join(" ") + " never exited");
  }
  return result;
};

describe("bin --help", () => {
  for (const bin of bins) {
    test(bin + " --help prints usage and exits 0", async () => {
      const ran = await run(bin, ["--help"]);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toMatch(/usage/i);
    });

    test(bin + " -h prints usage and exits 0", async () => {
      const ran = await run(bin, ["-h"]);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toMatch(/usage/i);
    });
  }
});

describe("bin unknown flag", () => {
  for (const bin of bins) {
    test(bin + " rejects --bogus with a usage error", async () => {
      const ran = await run(bin, ["--bogus"]);
      expect(ran.code).not.toBe(0);
      expect(ran.stdout + ran.stderr).toMatch(/usage/i);
    });
  }

  test("capture-bin rejects trailing --bogus with a usage error", async () => {
    const ran = await run("packages/session-quota/src/capture-bin.ts", ["pi-call", "--bogus"]);
    expect(ran.code).not.toBe(0);
    expect(ran.stdout + ran.stderr).toMatch(/usage/i);
  });
});
