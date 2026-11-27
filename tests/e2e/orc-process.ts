import { bundlePath, ensureBundle } from "./bundle"

ensureBundle()

export const runOrc = async (args: ReadonlyArray<string>, home: string): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const done = await Bun.$`${process.execPath} ${bundlePath} ${args}`.env({ ...process.env, HOME: home, ORC_HOME: "" }).quiet().nothrow()
  return { exitCode: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() }
}
