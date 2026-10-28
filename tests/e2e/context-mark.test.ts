import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { modelListCommand } from "../../packages/run/src/context-mark"

describe("modelListCommand", () => {
  test("rejects a probe that reads the run folder's Pi or installs packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-model-list-"))
    try {
      const fakeBin = join(dir, "bin")
      await mkdir(fakeBin)
      const nodePath = join(fakeBin, "node")
      await writeFile(nodePath, "#!/bin/sh\nexit 0\n")
      await chmod(nodePath, 0o755)
      await writeFile(join(fakeBin, "pi"), [
        "#!/bin/sh",
        "echo \"$*\" > \"" + fakeBin + "/argv\"",
        "echo \"$HOME\" > \"" + fakeBin + "/home\"",
        "if [ -z \"${PI_CODING_AGENT_DIR+x}\" ]; then echo unset > \"" + fakeBin + "/agentdir\"; else echo set > \"" + fakeBin + "/agentdir\"; fi",
        "cat > /dev/null",
        "exit 0"
      ].join("\n") + "\n")
      await chmod(join(fakeBin, "pi"), 0o755)
      const operatorHome = join(dir, "home")
      await mkdir(operatorHome)
      const parts = modelListCommand({ piBinary: join(fakeBin, "pi"), nodeBinary: nodePath, homeDir: operatorHome })
      const proc = Bun.spawn([...parts], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: join(dir, "wrong-home"), PI_CODING_AGENT_DIR: join(dir, "run-pi") }
      })
      const out = proc.stdout
      const err = proc.stderr
      if (!(out instanceof ReadableStream) || !(err instanceof ReadableStream)) {
        throw new Error("the probe has no piped output")
      }
      const [, , exitCode] = await Promise.all([new Response(out).text(), new Response(err).text(), proc.exited])
      expect(exitCode).toBe(0)
      const argv = (await readFile(join(fakeBin, "argv"), "utf8")).trim().split(/\s+/)
      const mode = argv.indexOf("--mode")
      expect(mode).not.toBe(-1)
      expect(argv[mode + 1]).toBe("rpc")
      expect(argv).toContain("--no-session")
      expect(argv).toContain("--no-extensions")
      expect(argv).toContain("--no-skills")
      expect(argv).toContain("--no-context-files")
      expect(argv).toContain("--offline")
      expect((await readFile(join(fakeBin, "home"), "utf8")).trim()).toBe(operatorHome)
      expect((await readFile(join(fakeBin, "agentdir"), "utf8")).trim()).toBe("unset")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
