import { describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { git, prUrl, runOrc, withNoSandboxFixture } from "./no-sandbox-fixture"

const refusedForms: ReadonlyArray<string> = [
  "bun test",
  "checks-test",
  "node_modules/.bin/checks-test",
  "./node_modules/.bin/playwright test",
  "node --test",
  "bun run verify",
  "bun run browser",
  "sh scripts/wrap.sh",
  "bun --filter app verify"
]

const permittedForms: ReadonlyArray<string> = ["bun run lint:e2e", "./node_modules/.bin/checks-lint tests/e2e", "bun run build"]

const quote = (word: string): string => "'" + word.replaceAll("'", "'\\''") + "'"

const fakeRunner = (name: string, shebang: string, trace: string): string =>
  shebang + "\nimport { appendFileSync } from \"node:fs\"\nappendFileSync(" + JSON.stringify(trace) + ", " + JSON.stringify(name + " ") +
  " + process.argv.slice(2).join(\" \") + \"\\n\")\n"

const writePackage = async (dir: string, manifest: unknown, files: Readonly<Record<string, string>> = {}): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), body, { mode: 0o755 })
  }
}

const writeRunnerProject = async (repo: string, trace: string): Promise<void> => {
  const modules = join(repo, "node_modules")
  await writePackage(join(modules, "@avi2dg", "checks"), { name: "@avi2dg/checks", bin: { "checks-test": "src/testing/test.ts", "checks-lint": "src/core/lint.ts" } }, {
    "src/testing/test.ts": fakeRunner("checks-test", "#!/usr/bin/env bun", trace),
    "src/core/lint.ts": fakeRunner("checks-lint", "#!/usr/bin/env bun", trace)
  })
  await writePackage(join(modules, "vitest"), { name: "vitest", bin: { vitest: "vitest.mjs" } }, { "vitest.mjs": fakeRunner("vitest", "#!/usr/bin/env node", trace) })
  await writePackage(join(modules, "@playwright", "test"), { name: "@playwright/test", bin: { playwright: "cli.js" } }, { "cli.js": fakeRunner("playwright", "#!/usr/bin/env node", trace) })
  await mkdir(join(modules, ".bin"))
  for (const [bin, target] of [
    ["checks-test", "../@avi2dg/checks/src/testing/test.ts"],
    ["checks-lint", "../@avi2dg/checks/src/core/lint.ts"],
    ["vitest", "../vitest/vitest.mjs"],
    ["playwright", "../@playwright/test/cli.js"]
  ] as const) {
    await symlink(target, join(modules, ".bin", bin))
  }
  await writePackage(repo, {
    name: "fixture",
    private: true,
    workspaces: ["packages/*"],
    scripts: { verify: "checks-test", browser: "playwright test", "lint:e2e": "checks-lint tests/e2e", build: "echo built" }
  }, { "scripts/wrap.sh": "#!/bin/sh\n./node_modules/.bin/vitest run\n" })
  await writePackage(join(repo, "packages", "app"), { name: "app", scripts: { verify: "vitest run" } })
}

const writeFormsProbe = async (repo: string, attempts: string, scratch: string): Promise<void> => {
  const lines = [...refusedForms, ...permittedForms].map((form) => [
    "sh -c " + quote(form) + " > " + quote(scratch) + " 2>&1; code=$?",
    "grep -q 'starts a test run' " + quote(scratch) + " && seen=refused || seen=ran",
    "printf '%s %s %s %s\\n' \"$1\" \"$code\" \"$seen\" " + quote(form) + " >> " + quote(attempts)
  ].join("\n"))
  await writeFile(join(repo, "forms.sh"), lines.join("\n") + "\n")
}

const expectedAttempts = (steps: ReadonlyArray<string>): ReadonlyArray<string> =>
  steps.flatMap((step) => [
    ...refusedForms.map((form) => step + " 1 refused " + form),
    ...permittedForms.map((form) => step + " 0 ran " + form)
  ])

describe("orc run refuses test runners in its own steps", () => {
  test("prepare, Pi and the local checks cannot start checks-test, bun test or an e2e runner by any route, while lint over tests/e2e still runs and the review spawn skips its test step", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const trace = join(fakeBin, "runner-starts")
      const attempts = join(fakeBin, "attempts")
      await writeRunnerProject(repo, trace)
      await writeFormsProbe(repo, attempts, join(fakeBin, "form-output"))
      await writeFile(join(repo, ".no-mistakes.yaml"), [
        "commands:",
        "  prepare: sh forms.sh prepare",
        "  build: sh forms.sh build",
        "  lint: bun run lint:e2e",
        ""
      ].join("\n"))
      git(repo, ["add", "-A"], env)
      git(repo, ["commit", "-qm", "Add runner project"], env)
      const piFile = join(fakeBin, "pi")
      const pi = await readFile(piFile, "utf8")
      await writeFile(piFile, pi.replace("echo hello > greeting.txt", "sh forms.sh pi\necho hello > greeting.txt"))
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      expect({ exitCode: result.exitCode, pr: result.stdout.includes(prUrl), output: result.exitCode === 0 ? "" : result.stdout + result.stderr }).toEqual({ exitCode: 0, pr: true, output: "" })
      expect((await readFile(attempts, "utf8")).trim().split("\n")).toEqual([...expectedAttempts(["prepare", "pi", "build"])])
      const lintStartsPerStep = permittedForms.filter((form) => form.includes("lint")).length
      const lintCheckStarts = 1
      expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual(Array.from({ length: 3 * lintStartsPerStep + lintCheckStarts }, () => "checks-lint tests/e2e"))
      const nmCalls = (await readFile(join(fakeBin, "nm-calls"), "utf8")).split("\n").filter((line) => line.startsWith("axi run"))
      expect(nmCalls).toHaveLength(1)
      expect(nmCalls[0]).toContain("--skip test")
    })
  }, 120_000)

  test("a prepare script that reaches checks-test through the package manager stops the run before Pi instead of running the suite", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const trace = join(fakeBin, "runner-starts")
      await writeRunnerProject(repo, trace)
      await writeFile(join(repo, ".no-mistakes.yaml"), "commands:\n  prepare: bun run verify\n  lint: test -f greeting.txt\n")
      git(repo, ["add", "-A"], env)
      git(repo, ["commit", "-qm", "Add runner project"], env)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      const output = result.stdout + result.stderr
      expect(result.exitCode).not.toBe(0)
      expect(output).toContain("orc: bun run verify exited 1 in the copy")
      const log = /its output is in (\S+prepare\.log)/.exec(output)?.[1] ?? ""
      expect(await readFile(log, "utf8")).toContain("starts a test run through checks-test")
      expect(await Bun.file(trace).exists()).toBe(false)
      expect(await Bun.file(join(fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})
