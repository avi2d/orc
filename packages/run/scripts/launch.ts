import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import manifest from "../package.json" with { type: "json" }

const { name, version } = manifest
const require = createRequire(import.meta.url)
const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const isStandin = process.argv[2] === "--orc-standin"
const args = process.argv.slice(isStandin ? 3 : 2)
const {
  ORC_LAUNCHER_BUN: bun,
  ORC_LAUNCHER_RESTORE: restore,
  ...env
} = process.env

for (const key of restore?.trim().split(" ") ?? []) {
  const saved = "_ORC_CALLER_" + key
  env[key] = env[saved]
  delete env[saved]
}

const npmGlobalSuffix = join("lib", "node_modules", name, "/")
if (packageRoot.endsWith("/" + npmGlobalSuffix)) {
  env.ORC_NPM_GLOBAL_PREFIX = packageRoot.slice(0, -npmGlobalSuffix.length)
} else {
  delete env.ORC_NPM_GLOBAL_PREFIX
}

const codeOf = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined

function nativeBinary(): string | undefined {
  try {
    return require.resolve(name + "-" + process.platform + "-" + process.arch + "/orc-" + version)
  } catch (error) {
    if (codeOf(error) !== "MODULE_NOT_FOUND") throw error
  }
  return undefined
}

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const

const run = (command: string, argv: ReadonlyArray<string>, environment: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: "inherit", env: environment })
    const handlers = signals.map((signal) => ({ signal, forward: () => { child.kill(signal) } }))
    for (const { signal, forward } of handlers) process.on(signal, forward)
    const detach = () => {
      for (const { signal, forward } of handlers) process.off(signal, forward)
    }
    child.once("error", (error) => {
      detach()
      reject(error)
    })
    child.once("exit", (code, signal) => {
      detach()
      if (code === null && signal !== null) process.kill(process.pid, signal)
      else process.exitCode = code ?? 1
      resolve()
    })
  })

async function launch(): Promise<void> {
  const binary = nativeBinary()
  if (binary !== undefined) {
    try {
      await run(binary, args, {
        ...env,
        ORC_BUNDLED_APP_DIR: join(packageRoot, "dist", "herdr-app"),
        ORC_LAUNCHED_MAIN: undefined,
        ORC_LAUNCHED_BINARY: binary
      })
      return
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error
    }
  }
  const main = join(packageRoot, "dist", isStandin ? "heavy-standin-main.ts" : "bin.js")
  const config = isStandin ? ["--no-env-file", "--config=/dev/null"] : []
  if (bun) {
    try {
      await run(bun, [...config, main, ...args], { ...env, ORC_BUNDLED_APP_DIR: join(packageRoot, "dist", "herdr-app"), ORC_LAUNCHED_BINARY: undefined, ORC_LAUNCHED_MAIN: main })
      return
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error
    }
  }
  throw new Error("no compiled binary for " + process.platform + "-" + process.arch +
    ". Install Bun for the bundled version, or reinstall Orc without omitting optional dependencies.")
}

await launch().catch((error: unknown) => {
  process.stderr.write("orc: " + (error instanceof Error ? error.message : String(error)) + "\n")
  process.exitCode = 1
})
