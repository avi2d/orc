import { Effect, FileSystem, Option } from "effect"
import { defaultHeavyTools } from "./heavy"
import { helperCommand, standinMarker, type StandinCall, type StandinTiming } from "./heavy-standin-runtime"

export type { StandinTiming } from "./heavy-standin-runtime"

export type HeavyPlatform = "darwin" | "linux" | "other"

export interface StandinSettings {
  readonly home: string
  readonly group: string
  readonly wrap: string
  readonly through: ReadonlyArray<string> | null
}

export const detectWrap = (platform: HeavyPlatform, limit: "auto" | "none"): string => {
  if (limit === "none") {
    return ""
  }
  if (platform === "darwin") {
    return "taskpolicy -c utility"
  }
  return ""
}

export const standinTools = (commands: ReadonlyArray<string>): ReadonlyArray<string> => {
  const extra = commands.map((entry) => entry.trim().split(" ")[0] ?? "").filter((tool) => tool !== "")
  return [...new Set([...defaultHeavyTools, ...extra])]
}

const isExecutableFile = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  fs.stat(file).pipe(
    Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
    Effect.orElseSucceed(() => false)
  )

const isStandinFile = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  Effect.scoped(
    fs.open(file).pipe(
      Effect.flatMap((handle) => handle.readAlloc(2048)),
      Effect.map((option) =>
        Option.match(option, {
          onNone: () => false,
          onSome: (bytes) => new TextDecoder().decode(bytes).includes(standinMarker)
        })
      ),
      Effect.orElseSucceed(() => false)
    )
  )

const findRealTool = (tool: string, pathValue: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (tool.includes("/") || tool === "" || tool === "." || tool === "..") {
      return ""
    }
    const fs = yield* FileSystem.FileSystem
    for (const entry of pathValue.split(":")) {
      if (!entry.startsWith("/")) {
        continue
      }
      const candidate = entry === "/" ? "/" + tool : entry + "/" + tool
      if (!(yield* isExecutableFile(fs, candidate))) {
        continue
      }
      if (yield* isStandinFile(fs, candidate)) {
        continue
      }
      return candidate
    }
    return ""
  })

const quoteSingle = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

const launcher = (call: StandinCall): string => {
  const [bun = "", ...flags] = helperCommand
  const main = flags.at(-1) ?? ""
  const fallback = call.real === "" ? "no " + call.tool + " was found when it was written" : "running " + call.real + " unqueued"
  const warning = "orc heavy: no bun at " + bun + " or no stand-in helper at " + main + "; " + fallback + ", rerun orc to rewrite the stand-ins"
  const direct = call.real === "" ? "exit 127" : "exec " + quoteSingle(call.real) + ' "$@"'
  return `#!/bin/sh
# ${standinMarker}. Regenerated on every run of that command.
[ -x ${quoteSingle(bun)} ] && [ -f ${quoteSingle(main)} ] && exec ${helperCommand.map(quoteSingle).join(" ")} ${quoteSingle(JSON.stringify(call))} "$0" "$@"
echo ${quoteSingle(warning)} >&2
[ -z "$HEAVY_CLASSIFY" ] || exit 1; ${direct}
`
}

export const standinScript = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>, timing?: StandinTiming): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const real = yield* findRealTool(tool, Bun.env.PATH ?? "")
    return launcher({ tool, commands, home: settings.home, group: settings.group, wrap: settings.wrap, real, through: settings.through, timing: timing ?? null })
  })

export const standinScripts = (
  settings: StandinSettings,
  commands: ReadonlyArray<string>,
  tools: ReadonlyArray<string> = standinTools(commands),
  timing?: StandinTiming
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const entries: Array<[string, string]> = []
    for (const tool of tools) {
      entries.push([tool, yield* standinScript(tool, settings, commands, timing)])
    }
    return Object.fromEntries(entries)
  })
