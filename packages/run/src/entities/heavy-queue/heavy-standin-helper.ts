import { dirname } from "node:path"

const embeddedRoot = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/

// A compiled file hands every argument to its own code and resolves modules inside its embedded file system, so it runs itself with no flags and no source path.
// Bun would otherwise load the caller's .env and bunfig.toml preloads into the stand-in.
export const helperCommandOf = (runtime: string, modulePath: string, main: string): ReadonlyArray<string> =>
  embeddedRoot.test(modulePath) ? [runtime] : [runtime, "--no-env-file", "--config=/dev/null", main]

// An npm update deletes the binary named for the old version, so a command orc keeps names the launcher npm keeps.
// Every child inherits the launcher's variables, so they hold only for the binary the launcher started.
export const launcherCommand = (env: Readonly<Record<string, string | undefined>>, executable: string): readonly [string, string] | null => {
  const { ORC_LAUNCHER_NODE: node, ORC_LAUNCHER: script, ORC_LAUNCHED_BINARY: binary } = env
  return node !== undefined && script !== undefined && binary === executable ? [node, script] : null
}

const launched = launcherCommand(Bun.env, process.execPath)

export const helperCommand: ReadonlyArray<string> = launched ?? helperCommandOf(
  process.execPath, import.meta.path, Bun.fileURLToPath(import.meta.resolve("./heavy-standin-main.ts"))
)

// Node reads the launcher's package and resolves the binary in its platform package, so a sandboxed helper reads both.
export const standinHelper = launched === null
  ? { runtime: helperCommand[0] ?? "", folders: [dirname(helperCommand.at(-1) ?? "")] }
  : { runtime: launched[0], folders: [dirname(dirname(launched[1])), dirname(process.execPath)] }
