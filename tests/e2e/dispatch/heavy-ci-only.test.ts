import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ciOnlyMarker, ciOnlyWord, helperCommand, standinMarker, type StandinCall } from "../../../packages/run/src/entities/heavy-queue/heavy-standin-runtime"

describe("CI-only runtime launchers", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orc-ci-only-"))
    await mkdir(join(root, "real"))
    for (const tool of ["bun", "bunx", "node", "checks-test"]) {
      await writeFile(join(root, "real", tool), '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', { mode: 0o755 })
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const launch = (tool: string, args: ReadonlyArray<string>, ciOnly = "1") => {
    const call: StandinCall = {
      tool, commands: [], home: root, group: "heavy", wrap: "", real: "", through: null, timing: null
    }
    return Bun.spawnSync([...helperCommand, JSON.stringify(call), join(root, "standin", tool), ...args], {
      cwd: root,
      env: { ...process.env, PATH: join(root, "real") + ":/usr/bin:/bin", PWD: root, HEAVY_TESTS_CI_ONLY: ciOnly, HEAVY_QUEUE_UNREACHABLE: "1" },
      stdout: "pipe",
      stderr: "pipe"
    })
  }

  test.each([
    ["bun", ["--bun", "run", "lint"]],
    ["bun", ["run", "--bun", "lint"]],
    ["bun", ["-b", "run", "lint"]],
    ["bun", ["x", "--bun", "stryker", "run"]],
    ["bun", ["x", "-b", "tool"]],
    ["bunx", ["--bun", "stryker", "run"]],
    ["bunx", ["-b", "tool"]]
  ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<string>]>)("%s %j cannot put Bun's node alias ahead of the stand-ins", (tool, args) => {
    const child = launch(tool, args)
    expect(child.exitCode).toBe(1)
    expect(child.stdout.toString()).toBe("")
    expect(child.stderr.toString()).toContain("can bypass CI-only runtime stand-ins")
  })

  test.each([
    ["bun", ["run", "lint"], "bunfig.toml"],
    ["bun", ["lint"], "bunfig.toml"],
    ["bun", ["x", "tool"], "bunfig.toml"],
    ["bunx", ["tool"], "bunfig.toml"],
    ["bun", ["run", "--cwd", "nested", "lint"], "nested/bunfig.toml"],
    ["bun", ["--cwd=nested", "run", "lint"], "nested/bunfig.toml"],
    ["bun", ["run", "--config=custom.toml", "lint"], "custom.toml"],
    ["bun", ["run", "-c", "custom.toml", "lint"], "custom.toml"]
  ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<string>, string]>)("%s %j cannot bypass the stand-ins through run.bun in %s", async (tool, args, config) => {
    await mkdir(join(root, "nested"))
    await writeFile(join(root, config), "[run]\nbun = true\n")
    const child = launch(tool, args)
    expect(child.exitCode).toBe(1)
    expect(child.stdout.toString()).toBe("")
    expect(child.stderr.toString()).toContain("sets run.bun = true")
  })

  test.each(["build", "install", "pm"])("run.bun does not refuse Bun's %s built-in", async (command) => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = true\n")
    const child = launch("bun", [command])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(join(root, "real/bun") + "\n" + command + "\n")
  })

  test("run.bun refuses bun check, because a package script named check runs in place of a Bun built-in", async () => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = true\n")
    const child = launch("bun", ["check"])
    expect(child.exitCode).toBe(1)
    expect(child.stdout.toString()).toBe("")
    expect(child.stderr.toString()).toContain("sets run.bun = true")
  })

  test.each([[["scripts/build.ts"]], [["run", "scripts/build.ts"]]] satisfies ReadonlyArray<readonly [ReadonlyArray<string>]>)("run.bun does not refuse bun %j on an existing file, which gets no node link", async (args) => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = true\n")
    await mkdir(join(root, "scripts"))
    await writeFile(join(root, "scripts/build.ts"), "")
    const child = launch("bun", args)
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe([join(root, "real/bun"), ...args].join("\n") + "\n")
  })

  test("run.bun refuses bun run on a file that a package script of the same name shadows", async () => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = true\n")
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { lint: "vitest run" } }))
    await writeFile(join(root, "lint"), "")
    const child = launch("bun", ["run", "lint"])
    expect(child.exitCode).toBe(1)
    expect(child.stdout.toString()).toBe("")
    expect(child.stderr.toString()).toContain("sets run.bun = true")
  })

  test("run.bun does not refuse an inline expression that starts no script or bin", async () => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = true\n")
    const child = launch("bun", ["--print", "1"])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(join(root, "real/bun") + "\n--print\n1\n")
  })

  test("run.bun false does not refuse an ordinary lint or consume its arguments", async () => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = false\n")
    const child = launch("bun", ["run", "lint", "--bun"])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(join(root, "real/bun") + "\nrun\nlint\n--bun\n")
  })

  test("Bun's runtime override remains available outside CI-only runs", async () => {
    await writeFile(join(root, "bunfig.toml"), "[run]\nbun = true\n")
    const child = launch("bun", ["--bun", "run", "lint"], "0")
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(join(root, "real/bun") + "\n--bun\nrun\nlint\n")
  })

  test.each(["node", "checks-test"])("the CI-only %s launcher does not skip a configured heavy launcher", async (tool) => {
    const ci = join(root, "heavy/ci-only")
    const copies = join(root, "copies")
    const heavy = join(root, "heavy/bin")
    for (const folder of [ci, copies, heavy]) {
      await mkdir(folder, { recursive: true })
    }
    for (const folder of [ci, copies]) {
      await writeFile(join(folder, tool), "#!/bin/sh\n# " + ciOnlyMarker + "\nexit 99\n", { mode: 0o755 })
    }
    await writeFile(join(heavy, tool), "#!/bin/sh\n# " + standinMarker + "\nprintf 'heavy launcher reached\\n'\n", { mode: 0o755 })
    const child = Bun.spawnSync([...helperCommand, ciOnlyWord, tool, join(ci, tool), "script.js"], {
      cwd: root,
      env: { ...process.env, PATH: [ci, copies, heavy, join(root, "real")].join(":"), HEAVY_TESTS_CI_ONLY: tool === "node" ? "1" : "0" },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(join(heavy, tool))
    const forwarded = Bun.spawnSync([child.stdout.toString(), "script.js"], { stdout: "pipe", stderr: "pipe" })
    expect(forwarded.exitCode).toBe(0)
    expect(forwarded.stdout.toString()).toBe("heavy launcher reached\n")
  })
})
