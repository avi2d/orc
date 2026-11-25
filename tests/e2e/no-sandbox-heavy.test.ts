import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runOrc, withNoSandboxFixture, writeScript } from "./no-sandbox-fixture"

const refused: ReadonlyArray<string> = [
  "bun test", "bun run test", "bunx vitest", "npm test", "npx jest", "node --test", "python -m pytest",
  "python3 -m pytest", "uv run pytest", "make test", "make check", "deno test", "cargo t",
  "node --import tsx --test", "node --experimental-strip-types --test test/", "python -B -m pytest",
  "python3 -I -m pytest", "uv run --frozen pytest", "uv run --locked pytest", "uv run --no-sync pytest",
  "uv run python -m pytest", "uv run python3 -B -m pytest", "node --test --watch", "deno test --watch"
]

const queued: ReadonlyArray<string> = ["bun run build", "tsc", "eslint", "cargo build"]

const direct: ReadonlyArray<string> = [
  "make build", "make -C test build", "make -f check build", "make -o test build", "make --directory test build",
  "node script.js", "node script.js --test", "node --import tsx script.js --test",
  "python -B script.py", "python3 -m http.server", "uv run --frozen python script.py"
]

const refusal = (call: string): string =>
  "orc heavy: " + call + " starts a test run, and with HEAVY_TESTS_CI_ONLY=1 the repository tests run only in GitHub CI\n"

const quoted = (word: string): string => "'" + word + "'"

describe("orc run --sandbox none", () => {
  test("refuses test runners through the heavy stand-ins while builds and scripts pass through", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const scratch = join(fakeBin, "..", "scratch")
      const calls = join(fakeBin, "calls")
      await mkdir(scratch)
      await mkdir(calls)
      await writeFile(join(scratch, "package.json"), JSON.stringify({ scripts: { build: "true" } }))
      await writeScript(join(fakeBin, "tsc"), ["exit 0"])
      await writeScript(join(fakeBin, "eslint"), ["exit 0"])
      for (const tool of ["node", "python", "python3", "uv", "make", "deno", "cargo"]) {
        await writeScript(join(fakeBin, tool), ["exit 0"])
      }
      const piPath = join(fakeBin, "pi")
      const plainPi = join(fakeBin, "plain-pi")
      await writeFile(plainPi, await readFile(piPath))
      await chmod(plainPi, 0o755)
      await writeScript(piPath, [
        "if [ \"$1\" = -p ]; then",
        "  i=0",
        "  for call in " + [...refused, ...queued, ...direct].map(quoted).join(" ") + "; do",
        "    i=$((i + 1))",
        "    (cd " + quoted(scratch) + " && HEAVY_QUEUE_BYPASS='no pueue in the fixture' $call) > /dev/null 2> " + quoted(calls) + "/$i.err",
        "    echo $? > " + quoted(calls) + "/$i.code",
        "  done",
        "fi",
        "exec " + quoted(plainPi) + " \"$@\""
      ])
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      const recorded = async (index: number) => ({
        code: (await readFile(join(calls, String(index + 1) + ".code"), "utf8")).trim(),
        stderr: await readFile(join(calls, String(index + 1) + ".err"), "utf8")
      })
      for (const [index, call] of refused.entries()) {
        expect({ call, ...(await recorded(index)) }).toEqual({ call, code: "1", stderr: refusal(call) })
      }
      for (const [index, call] of queued.entries()) {
        const { code, stderr } = await recorded(refused.length + index)
        expect({ call, code, queued: stderr.includes("orc heavy: bypassing the heavy queue") }).toEqual({ call, code: "0", queued: true })
      }
      for (const [index, call] of direct.entries()) {
        const { code, stderr } = await recorded(refused.length + queued.length + index)
        expect({ call, code, stderr }).toEqual({ call, code: "0", stderr: "" })
      }
    })
  }, 60_000)
})
