#!/usr/bin/env bun
import { Console, Data, Effect, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"

class CommandsPageError extends Data.TaggedError("CommandsPageError")<{
  readonly message: string
}> {}

const entry = "packages/run/src/bin.ts"
const page = "docs/reference/commands.md"

const helpOf = (words: ReadonlyArray<string>): Effect.Effect<string, CommandsPageError> =>
  Effect.tryPromise({
    try: () => {
      const ran = Bun.spawn([process.execPath, entry, ...words, "--help"], { stdout: "pipe", stderr: "pipe" })
      return Promise.all([ran.exited, new Response(ran.stdout).text(), new Response(ran.stderr).text()])
    },
    catch: (cause) => new CommandsPageError({ message: "cannot run orc " + words.join(" ") + " --help: " + String(cause) })
  }).pipe(
    Effect.flatMap(([exitCode, stdout, stderr]) =>
      exitCode === 0
        ? Effect.succeed(stdout.trimEnd())
        : Effect.fail(new CommandsPageError({ message: "orc " + words.join(" ") + " --help exited " + exitCode.toString() + ": " + stderr.trim() }))
    )
  )

interface Group {
  readonly title: string
  readonly commands: ReadonlyArray<string>
}

const rowName = /^ {2}([a-z][a-z-]*) {2,}\S/

const groupsOf = (overview: string): ReadonlyArray<Group> => {
  const groups: Array<{ readonly title: string; readonly commands: Array<string> }> = []
  for (const line of overview.split("\n")) {
    const name = rowName.exec(line)?.[1]
    const open = groups.at(-1)
    if (name !== undefined && open !== undefined) {
      open.commands.push(name)
    } else if (/^[A-Z].*:$/.test(line) && !line.startsWith("Usage")) {
      groups.push({ title: line.slice(0, -1), commands: [] })
    }
  }
  return groups.filter((group) => group.commands.length > 0)
}

const subcommandsOf = (help: string): ReadonlyArray<string> => {
  const lines = help.split("\n")
  const from = lines.indexOf("Subcommands:")
  if (from === -1) {
    return []
  }
  const names: Array<string> = []
  for (const line of lines.slice(from + 1)) {
    if (line === "") {
      break
    }
    const name = rowName.exec(line)?.[1]
    if (name !== undefined) {
      names.push(name)
    }
  }
  return names
}

const fence = "```"

const section = (level: string, words: ReadonlyArray<string>, help: string): string =>
  [level + " orc " + words.join(" "), "", fence + "text", help, fence, ""].join("\n")

const commandSections = (command: string): Effect.Effect<string, CommandsPageError> =>
  Effect.gen(function*() {
    const help = yield* helpOf([command])
    const subs = yield* Effect.forEach(subcommandsOf(help), (sub) =>
      helpOf([command, sub]).pipe(Effect.map((text) => section("####", [command, sub], text)))
    )
    return [section("###", [command], help), ...subs].join("\n")
  })

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const overview = yield* helpOf([])
  const groups = yield* Effect.forEach(groupsOf(overview), (group) =>
    Effect.forEach(group.commands, commandSections).pipe(
      Effect.map((sections) => ["## " + group.title, "", ...sections].join("\n"))
    )
  )
  if (groups.length === 0) {
    return yield* new CommandsPageError({ message: "orc --help lists no command group" })
  }
  const text = [
    "---",
    "kind: reference",
    "outline: deep",
    "---",
    "# Commands",
    "",
    "Every `orc` command and subcommand, with the text its `--help` prints.",
    "`bun run build` writes this whole page from that help text through `scripts/docs-commands.ts`, so a change belongs in `packages/run/src/app` and never here.",
    "",
    "## Every command",
    "",
    fence + "text",
    overview,
    fence,
    "",
    ...groups
  ].join("\n")
  yield* fs.makeDirectory("docs/reference", { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(page, text)),
    Effect.mapError((cause) => new CommandsPageError({ message: "cannot write " + page + ": " + String(cause) }))
  )
  yield* Console.log("docs-commands: wrote " + page)
}).pipe(Effect.provide(BunServices.layer))

void Effect.runPromise(program)
