#!/usr/bin/env bun
import { Console, Data, Effect, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"
import { app } from "./diagrams/app"
import { attention } from "./diagrams/attention"
import { backlog } from "./diagrams/backlog"
import { beat } from "./diagrams/beat"
import { chat } from "./diagrams/chat"
import { checks } from "./diagrams/checks"
import { merge } from "./diagrams/merge"
import { quota } from "./diagrams/quota"
import { run } from "./diagrams/run"
import { runner } from "./diagrams/runner"
import { top } from "./diagrams/top"

class DiagramsError extends Data.TaggedError("DiagramsError")<{
  readonly message: string
}> {}

const folder = "docs/diagrams"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const drawings = [top, backlog, beat, quota, runner, run, checks, merge, attention, chat, app].flatMap((draw) => draw())
  const short = drawings.flatMap((drawing) => drawing.shortCards.map((reason) => drawing.name + ": " + reason))
  if (short.length > 0) {
    return yield* new DiagramsError({ message: "a card is too short for its text:\n" + short.join("\n") })
  }
  const style = yield* fs.readFileString(folder + "/diagram.css")
  yield* Effect.forEach(drawings, (drawing) => fs.writeFileString(folder + "/" + drawing.name + ".svg", drawing.markup(style)))
  yield* Console.log("docs-diagrams: wrote " + drawings.length.toString() + " drawings")
}).pipe(Effect.provide(BunServices.layer))

void Effect.runPromise(program)
