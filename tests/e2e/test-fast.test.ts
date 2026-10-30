import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testFast = join(import.meta.dir, "..", "..", "scripts", "test-fast.ts");
const PASSING = 'import { expect, test } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n';

const FAILING = 'import { expect, test } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n';

let dir = "";

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const environment = (): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: dir,
  GIT_AUTHOR_NAME: "Fixture User",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture User",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
});

interface Ran {
  readonly code: number;
  readonly text: string;
}

const run = async (args: string[], cwd: string): Promise<Ran> => {
  const child = Bun.spawn(args, { cwd, env: environment(), stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const text = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  return { code, text };
};

const git = (args: readonly string[]): Promise<Ran> => run(["git", ...args], dir);

async function repository(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "tui-dash-test-fast-"));
  mkdirSync(join(dir, "tests", "unit"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-fast-fixture", type: "module" }));
  writeFileSync(join(dir, "tests", "unit", "a.test.ts"), PASSING);
  await git(["init", "-q", "-b", "main", "."]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "feat: base"]);
}

const fast = (): Promise<Ran> => run(["bun", testFast], dir);

test("a clone without the remote-tracking default branch fails before any tier runs", async () => {
  await repository();
  await git(["checkout", "-q", "-b", "feature"]);
  mkdirSync(join(dir, "tests", "e2e"), { recursive: true });
  writeFileSync(join(dir, "tests", "e2e", "b.test.ts"), PASSING);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "test: add an e2e file"]);

  const refused = await fast();
  expect(refused.code).toBe(2);
  expect(refused.text).toContain("cannot find where HEAD branched from origin/main");
  expect(refused.text).not.toContain("1 pass");
}, 120_000);

test("a change touching no e2e files runs only the unit tier", async () => {
  await repository();
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "tests", "unit", "c.test.ts"), PASSING);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "test: add a unit file"]);

  const ran = await fast();
  expect(ran.text).toContain("the change touches no e2e test files, so only the unit tier ran");
  expect(ran.code).toBe(0);
}, 120_000);

test("an untouched e2e file whose path contains the touched path does not run", async () => {
  await repository();
  mkdirSync(join(dir, "tests", "e2e"), { recursive: true });
  writeFileSync(join(dir, "tests", "e2e", "x.test.tsx"), FAILING);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "test: add a lookalike e2e file"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "tests", "e2e", "x.test.ts"), PASSING);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "test: add an e2e file"]);

  const ran = await fast();
  expect(ran.text).toContain("the change touches 1 e2e test file(s): tests/e2e/x.test.ts");
  expect(ran.text).not.toContain("x.test.tsx");
  expect(ran.code).toBe(0);
}, 120_000);
