#!/usr/bin/env bun
import { arch, cpus, platform, release } from "node:os"
import { Console, Data, Effect } from "effect"
import { helperCommand } from "../packages/run/src/entities/heavy-queue/heavy-standin-runtime"

class BenchStartError extends Data.TaggedError("BenchStartError")<{
  readonly message: string
}> {}

interface Options {
  readonly runs: number
  readonly orc: string
  readonly standin: string
}

const usage = "usage: bun scripts/bench-start.ts [--runs N] [--orc FILE] [--standin FILE]"

const defaults: Options = {
  runs: 20,
  orc: "packages/run/src/bin.ts",
  standin: "packages/run/src/entities/heavy-queue/heavy-standin-main.ts"
}

const parseOptions = (words: ReadonlyArray<string>): Effect.Effect<Options, BenchStartError> =>
  Effect.gen(function*() {
    const options = { ...defaults }
    for (let index = 0; index < words.length; index += 2) {
      const flag = words[index] ?? ""
      if (index + 1 >= words.length) {
        return yield* new BenchStartError({ message: flag + " takes a value\n" + usage })
      }
      const value = words[index + 1] ?? ""
      if (flag === "--runs") {
        const runs = Number(value)
        if (!Number.isInteger(runs) || runs < 1) {
          return yield* new BenchStartError({ message: "--runs takes a whole number above 0, not " + value })
        }
        options.runs = runs
      } else if (flag === "--orc") {
        options.orc = value
      } else if (flag === "--standin") {
        options.standin = value
      } else {
        return yield* new BenchStartError({ message: "unknown option " + flag + "\n" + usage })
      }
    }
    return options
  })

const isScript = (file: string): boolean => /\.[jt]s$/.test(file)

const orcArgv = (target: string): ReadonlyArray<string> =>
  isScript(target) ? [process.execPath, target, "--help"] : [target, "--help"]

const standinCall = JSON.stringify({ tool: "bun", commands: [], home: "", group: "heavy", wrap: "", real: "", through: null, timing: null })

const standinArgv = (target: string): ReadonlyArray<string> => [
  ...(isScript(target) ? [process.execPath, ...helperCommand.slice(1, -1), target] : [target]),
  standinCall, "bench-standin", "test", "x"
]

interface Case {
  readonly name: string
  readonly target: string
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly expect: (stdout: string) => boolean
}

const timeOnce = (entry: Case): Effect.Effect<number, BenchStartError> =>
  Effect.gen(function*() {
    const started = performance.now()
    const [exitCode, stdout, stderr] = yield* Effect.tryPromise({
      try: () => {
        const ran = Bun.spawn([...entry.argv], { stdout: "pipe", stderr: "pipe", env: entry.env })
        return Promise.all([ran.exited, new Response(ran.stdout).text(), new Response(ran.stderr).text()])
      },
      catch: (cause) => new BenchStartError({ message: "cannot start " + entry.argv.join(" ") + ": " + String(cause) })
    })
    const elapsed = performance.now() - started
    if (exitCode !== 0 || !entry.expect(stdout)) {
      return yield* new BenchStartError({
        message: entry.name + " exited " + String(exitCode) + " with output " + JSON.stringify(stdout.slice(0, 200)) + ": " + stderr
      })
    }
    return elapsed
  })

const median = (sorted: ReadonlyArray<number>): number => {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const nearestRank = (sorted: ReadonlyArray<number>, share: number): number => sorted[Math.ceil(share * sorted.length) - 1] ?? 0

const ms = (value: number): string => value.toFixed(1) + " ms"

const measure = (entry: Case, runs: number): Effect.Effect<string, BenchStartError> =>
  Effect.gen(function*() {
    yield* timeOnce(entry)
    const times: Array<number> = []
    for (let run = 0; run < runs; run += 1) {
      times.push(yield* timeOnce(entry))
    }
    const sorted = times.toSorted((left, right) => left - right)
    return entry.name.padEnd(18) + "median " + ms(median(sorted)).padEnd(10) + "  p90 " + ms(nearestRank(sorted, 0.9)).padEnd(10) + "  " + entry.target
  })

const program = Effect.gen(function*() {
  const options = yield* parseOptions(process.argv.slice(2))
  const cases: ReadonlyArray<Case> = [
    { name: "orc --help", target: options.orc, argv: orcArgv(options.orc), env: process.env, expect: (stdout) => stdout.trim() !== "" },
    {
      name: "stand-in classify",
      target: options.standin,
      argv: standinArgv(options.standin),
      env: { ...process.env, HEAVY_CLASSIFY: "1" },
      expect: (stdout) => stdout.trim() === "1 1"
    }
  ]
  yield* Console.log(
    "bun " + Bun.version + ", " + platform() + " " + release() + " " + arch() + ", " + (cpus()[0]?.model ?? "unknown CPU") + ", " +
      String(options.runs) + " runs after 1 warm-up"
  )
  for (const entry of cases) {
    yield* Console.log(yield* measure(entry, options.runs))
  }
})

void Effect.runPromise(
  program.pipe(
    Effect.catchTag("BenchStartError", (error) =>
      Console.error("bench-start: " + error.message).pipe(Effect.andThen(Effect.sync(() => {
        process.exitCode = 1
      }))))
  )
)
