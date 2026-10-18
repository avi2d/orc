#!/usr/bin/env bun
import { runMain } from "@effect/platform-bun/BunRuntime"
import { Console, Effect } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { parseArgs } from "./args"

const usage = "Usage: orc [--version] [--help]"

const program = Effect.gen(function*() {
  const args = parseArgs(Bun.argv.slice(2))
  switch (args.kind) {
    case "PrintVersion": {
      yield* Console.log(`orc ${packageJson.version}`)
      break
    }
    case "PrintHelp": {
      yield* Console.log(usage)
      break
    }
    case "UsageError": {
      yield* Console.error(`${args.detail}\n${usage}`)
      return yield* Effect.fail(args.detail)
    }
  }
})

runMain(program, { disableErrorReporting: true })
