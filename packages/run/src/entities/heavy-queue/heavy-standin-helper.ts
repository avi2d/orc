import { realpathSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"

const embeddedRoot = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/

// A compiled file hands every argument to its own code and resolves modules inside its embedded file system, so it runs itself with no flags and no source path.
// Bun would otherwise load the caller's .env and bunfig.toml preloads into the stand-in.
export const helperCommandOf = (runtime: string, modulePath: string, main: string): ReadonlyArray<string> =>
  embeddedRoot.test(modulePath) ? [runtime] : [runtime, "--no-env-file", "--config=/dev/null", main]

// Children inherit these variables, so require the binary or source file the launcher started.
export const launcherCommand = (env: Readonly<Record<string, string | undefined>>, executable: string, main: string): readonly [string] | null => {
  const { ORC_LAUNCHER_ENTRY: entry, ORC_LAUNCHED_BINARY: binary, ORC_LAUNCHED_MAIN: source } = env
  if (entry === undefined || !isAbsolute(entry)) return null
  return (binary === undefined ? source === main : binary === executable) ? [entry] : null
}

const launched = launcherCommand(Bun.env, process.execPath, Bun.main)

export const helperCommand: ReadonlyArray<string> = launched === null
  ? helperCommandOf(process.execPath, import.meta.path, Bun.fileURLToPath(import.meta.resolve("./heavy-standin-main.ts")))
  : [...launched, "--orc-standin"]

export const helperEntry = launched?.[0] ?? helperCommand.at(-1) ?? ""

const packageFolders = (entry: string): ReadonlyArray<string> => {
  try {
    const launcherPackage = dirname(dirname(realpathSync(entry)))
    return Bun.env.ORC_LAUNCHED_BINARY === undefined ? [launcherPackage] : [launcherPackage, dirname(process.execPath)]
  } catch {
    return []
  }
}

export const standinHelper = launched === null
  ? { runtime: helperCommand[0] ?? "", folders: [dirname(helperEntry)] }
  : { runtime: launched[0], folders: packageFolders(launched[0]) }
