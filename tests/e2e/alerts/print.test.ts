import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

const fixtures = join(root, "tests", "fixtures", "alerts");

const home = mkdtempSync(join(tmpdir(), "tui-dash-alerts-panel-e2e-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const printed = async (environment: Record<string, string>): Promise<string> => {
  const child = Bun.spawn(["bun", join(root, "packages", "cli", "src", "bin.ts"), "panel", "alerts", "--print"], {
    cwd: root,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`the print exited ${code}: ${stderr}`);
  return stdout;
};

describe("tui-dash panel alerts --print", () => {
  test("reads the settings and the verdict log from their default paths", async () => {
    const state = join(home, ".local", "state", "tui-dash");
    const config = join(home, ".config", "tui-dash");
    await Bun.write(join(state, "alerts-verdicts.jsonl"), Bun.file(join(fixtures, "verdicts.jsonl")));
    await Bun.write(join(config, "config.json"), Bun.file(join(fixtures, "..", "config", "config.json")));
    appendFileSync(join(state, "alerts-verdicts.jsonl"), "verdict: fine\n");
    const frame = await printed({});
    expect(frame).toContain("limits   quiet 20m, then every 10m · past 3h in total");
    expect(frame).toContain("verdict  expected, a nightly baseline runs on south");
    const rows = frame.split("\n");
    const start = rows.findIndex((line) => line.startsWith("verdicts "));
    const end = rows.findIndex((line, index) => index > start && !line.startsWith("         "));
    const warning = rows.slice(start, end).map((line) => line.slice(9).trim()).join("");
    expect(warning).toContain(join(state, "alerts-verdicts.jsonl"));
    expect(warning).toContain("is not a verdict record");
  });

  test("reads the verdict log TUI_DASH_ALERTS_VERDICTS names", async () => {
    const elsewhere = join(home, "elsewhere.jsonl");
    copyFileSync(join(fixtures, "verdicts.jsonl"), elsewhere);
    const frame = await printed({ TUI_DASH_ALERTS_VERDICTS: elsewhere, TUI_DASH_CONFIG: join(home, "absent.json") });
    expect(frame).toContain("earlier  ");
    expect(frame).toContain("limits   quiet 15m, then every 15m · past 2h in total");
    expect(frame).not.toContain("! ");
  });
});
