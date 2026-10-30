import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = join(import.meta.dir, "..", "..", "..", "packages", "cli", "src", "bin.ts");

const home = mkdtempSync(join(tmpdir(), "tui-dash-panel-e2e-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (args: ReadonlyArray<string>, config = join(home, "absent.json")): Promise<Ran> => {
  const child = Bun.spawn(["bun", command, ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: home, TUI_DASH_CONFIG: config },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};

const panels = ["quota", "session-quota", "alerts", "resources", "queues", "schedules", "dispatch", "tasks", "ledger"];

describe("tui-dash panel", () => {
  test("--list names every panel with what it shows", async () => {
    const listed = await run(["panel", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split("\n").filter((line) => line !== "").map((line) => line.split(/ +/u)[0])).toEqual(panels);
  });

  for (const panel of panels) {
    test(`${panel} --help lists the frame flags`, async () => {
      const help = await run(["panel", panel, "--help"]);
      expect(help.code).toBe(0);
      for (const flag of ["--print", "--color", "--width", "--height"]) expect(help.stdout).toContain(flag);
    });

    test(`${panel} --color without --print is refused`, async () => {
      const refused = await run(["panel", panel, "--color"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("--color colours a printed frame, so pass --print with it");
    });
  }

  for (const [flag, value, unit] of [
    ["--width", "0", "columns"],
    ["--width", "-40", "columns"],
    ["--height", "0", "rows"],
  ] as const) {
    test(`refuses ${flag} ${value}`, async () => {
      const refused = await run(["panel", "quota", "--print", flag, value]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`Invalid value for flag ${flag}: "${value}". Expected: a whole number of ${unit} from 1 up`);
    });
  }

  test("refuses a --width that is not a number", async () => {
    const refused = await run(["panel", "quota", "--print", "--width", "wide"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Invalid value for flag --width: "wide"');
  });

  test("refuses a panel no module is called, naming the panels", async () => {
    const refused = await run(["panel", "nope", "--print"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("nope");
    for (const panel of panels) expect(refused.stderr).toContain(panel);
  });

  test("asks for a panel when none is named", async () => {
    const refused = await run(["panel"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--list");
  });

  test("refuses a config whose panels section names no panel", async () => {
    const config = join(home, "stray.json");
    writeFileSync(config, JSON.stringify({ panels: { nope: {} } }));
    const refused = await run(["panel", "quota", "--print"], config);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`panels.nope in ${config} is not a panel`);
  });
});

describe("a setting the command refuses", () => {
  const written = (name: string, body: unknown): string => {
    const path = join(home, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, string, unknown]> = [
    ["a panel's own section", ["panel", "quota", "--print"], "panels.quota", { panels: { quota: { every: 5 } } }],
    ["the layout", ["--print", "--width", "84", "--height", "24"], "layout", { layout: { wied: [] } }],
    ["the appearance", ["panel", "quota", "--print"], "appearance", { appearance: { tones: { accnet: "#000000" } } }],
  ];
  for (const [what, args, section, body] of cases) {
    test(`names ${what} and the config file it sits in`, async () => {
      const config = written(`${section}.json`, body);
      const refused = await run(args, config);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`${section} in ${config} is not valid: `);
    });
  }

  test("names alerts.json when it stands in for an absent config.json", async () => {
    const legacy = written("alerts.json", { quotaPace: { everySecond: 45 } });
    const refused = await run(["panel", "alerts", "--print"], join(home, "config.json"));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`panels.alerts in ${legacy} is not valid: `);
  });
});

describe("tui-dash", () => {
  test("refuses --color without --print", async () => {
    const refused = await run(["--color"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--color colours a printed frame, so pass --print with it");
  });
});
