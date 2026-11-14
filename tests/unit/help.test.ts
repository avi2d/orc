import { describe, expect, test } from "bun:test"
import { parseArgs } from "../../packages/run/src/app/args"
import { closestWord, helpText, helpTopic, overview, usageErrorText } from "../../packages/run/src/app/help"
import { formatOverview, terminalWidth } from "../../packages/run/src/app/help-format"

interface Invocation {
  readonly path: ReadonlyArray<string>
  readonly positionals: ReadonlyArray<string>
  readonly flags: ReadonlyArray<string>
  readonly tail: ReadonlyArray<string>
  readonly companions: ReadonlyArray<string>
}

const call = (path: ReadonlyArray<string>, positionals: ReadonlyArray<string> = [], flags: ReadonlyArray<string> = [], tail: ReadonlyArray<string> = [], companions: ReadonlyArray<string> = []): Invocation => ({ path, positionals, flags, tail, companions })

const invocations: ReadonlyArray<Invocation> = [
  call(["run"], ["t.md"]),
  call(["runs"]),
  call(["show"], ["r1"]),
  call(["log"], ["r1", "1"]),
  call(["score"], ["r1", "s", "3"]),
  call(["refusals"]),
  call(["backlog"]),
  call(["backlog", "add"], ["orc", "t.md"]),
  call(["backlog", "edit"], ["orc-9", "t.md"]),
  call(["backlog", "close"], ["orc-9", "done"]),
  call(["backlog", "stop"], ["orc-9"]),
  call(["backlog", "posted"], ["orc-9"]),
  call(["backlog", "hold"], ["orc-9"], ["--reason", "x"]),
  call(["backlog", "answer"], ["orc-9", "yes"], [], [], ["--expect", "held"]),
  call(["backlog", "note"], ["orc-9", "hi"]),
  call(["backlog", "depend"], ["orc-9"], ["--clear"]),
  call(["backlog", "plan"], ["orc-9"]),
  call(["backlog", "priority"], ["orc-9", "0"]),
  call(["attention"]),
  call(["attention", "answer"], ["orc-9.run-died", "hi"]),
  call(["beat"]),
  call(["merge"], ["orc-9"]),
  call(["runner", "start"]),
  call(["runner", "queue"]),
  call(["runner", "renew"]),
  call(["runner", "hold"], ["orc-9"], [], ["--", "orc", "run"]),
  call(["runner", "token"], ["f.json"]),
  call(["runner", "result"], ["orc-9"]),
  call(["runner", "kill"], ["orc-9"]),
  call(["runner", "answer"], ["orc-9"]),
  call(["runner", "load"]),
  call(["heavy", "path"]),
  call(["heavy", "check"]),
  call(["heavy", "watch"]),
  call(["heavy", "watch-once"]),
  call(["chat"]),
  call(["app", "install"])
]

const words = (invocation: Invocation, flags = invocation.flags, positionals = invocation.positionals): Array<string> =>
  [...invocation.path, ...positionals, ...flags, ...invocation.tail]

const accepted = (args: ReadonlyArray<string>): boolean => parseArgs(args).kind !== "UsageError"

const entryOf = (invocation: Invocation) => {
  const topic = helpTopic(invocation.path)
  if (topic === null || topic.path !== invocation.path.join(" ")) {
    throw new Error("no help entry for orc " + invocation.path.join(" "))
  }
  return topic.entry
}

const parserFlags = ["--json", "--kind", "--delivery", "--branch", "--sandbox", "--token-file", "--provider", "--instructions", "--allow", "--answer", "--internal", "--machine", "--parent", "--depends-on", "--reason", "--until", "--question", "--expect", "--generation", "--on", "--clear", "--drop", "--basis", "--priority", "--label", "--stdin-label", "--force", "--dry-run", "--all", "--verbose"]

const values = ["", "x", "1", "orc-1", "q=1", "2026-12-01", "ship", "no-mistakes", "none", "ask-user", "parked", "yolo-green"]

const flagPlacements = (invocation: Invocation, probe: ReadonlyArray<string>): Array<Array<string>> => {
  const [first = "", ...rest] = invocation.positionals
  return [words(invocation, probe), [...invocation.path, ...(first === "" ? [] : [first]), ...probe, ...rest, ...invocation.tail]]
}

const parserTakesFlag = (invocation: Invocation, flag: string): boolean =>
  [invocation.flags, [], [...invocation.flags, ...invocation.companions]].some((flags) =>
    values.some((value) =>
      flagPlacements(invocation, [...flags, flag, ...(value === "" ? [] : [value])]).some((args) => {
        const result = parseArgs(args)
        return result.kind !== "UsageError" && !JSON.stringify(result).includes(flag)
      })))

const documentedFlags = (invocation: Invocation): Array<string> =>
  [...new Set(entryOf(invocation).usage.flatMap((line) => [...line.matchAll(/(--[a-z][a-z-]*)/g)].map((match) => match[1])))]

const usageLineSlots = (line: string): number => {
  const tokens = line.split(" ").slice(1 + line.split(" ").findIndex((token, index) => index > 0 && !/^[a-z-]+$/.test(token)) - 1)
  return tokens.filter((token, index) => /^\[?</.test(token) && !/^\[?--/.test(tokens[index - 1] ?? "")).length
}

const parserSlots = (invocation: Invocation): number => {
  const extra = parseArgs(words(invocation, invocation.flags, [...invocation.positionals, "spare"]))
  return invocation.positionals.length + (extra.kind !== "UsageError" && JSON.stringify(extra).includes('"spare"') ? 1 : 0)
}

const overviewNames = (text: string): Array<string> => [...text.matchAll(/^ {2}([a-z]+) {2,}/gm)].map((match) => match[1])

describe("orc help", () => {
  test("the overview lists every top-level command instead of a partial or padded list", () => {
    const listed = overviewNames(overview())
    expect(listed.toSorted()).toEqual(["app", "attention", "backlog", "beat", "chat", "heavy", "log", "merge", "refusals", "run", "runner", "runs", "score", "show"])
    expect(listed).toEqual(expect.arrayContaining(["run", "runs", "show", "score", "chat", "backlog", "beat", "merge", "runner"]))
  })

  test("the overview starts every group's descriptions at one column instead of a ragged one per group", () => {
    const starts = [...overview().matchAll(/^ {2}[a-z]+( {2,})/gm)].map((match) => match[0].length)
    expect(new Set(starts).size).toBe(1)
  })

  test("a summary past 80 columns wraps under its own column instead of running off the line", () => {
    const text = formatOverview("orc.", [
      { group: "First:", rows: [["go", "Start one task in this checkout, then watch every check it runs until the last one is green"]] },
      { group: "Second:", rows: [["stopall", "Stop it"]] }
    ])
    expect(text.split("\n")).toEqual([
      "orc.",
      "",
      "Usage: orc <command> [<args>]",
      "       orc --help | --version",
      "",
      "First:",
      "  go       Start one task in this checkout, then watch every check it runs until",
      "           the last one is green",
      "",
      "Second:",
      "  stopall  Stop it",
      "",
      "Run orc <command> --help to learn what a command does and the options it takes."
    ])
  })

  test("no line of the overview or any command's help runs past 80 columns", () => {
    const pages = [overview(), ...invocations.map((invocation) => helpText(invocation.path)), helpText(["backlog"]), helpText(["runner"]), helpText(["heavy"])]
    const long = pages.flatMap((page) => page.split("\n")).filter((line) => line.length > terminalWidth)
    expect(long).toEqual([])
  })

  test("each command's --help names only that command instead of printing the whole list", () => {
    const pages = invocations.map((invocation) => {
      const result = parseArgs([...invocation.path, "--help"])
      const text = result.kind === "PrintHelp" ? helpText(result.words) : ""
      const usage = text.split("\n\n")[0].split("\n").filter((line) => !line.startsWith(" ".repeat(11)))
      return { path: invocation.path.join(" "), usageNamesOnlyIt: usage.length > 0 && usage.every((line) => line.replace(/^(Usage:)? +/, "").startsWith("orc " + invocation.path.join(" "))), overview: text.includes("Run a task:") }
    })
    expect(pages).toEqual(invocations.map((invocation) => ({ path: invocation.path.join(" "), usageNamesOnlyIt: true, overview: false })))
  })

  test("a wrong subcommand prints only its own command's usage instead of every command", () => {
    const text = usageErrorText("unexpected argument: hodl", ["backlog", "hodl", "orc-9"])
    expect(text).toContain("Usage: orc backlog [--json]")
    expect(text).toContain("Run orc backlog --help for more.")
    expect(text).not.toContain("orc runner")
    expect(text).not.toContain("Run a task:")
  })

  test("an unknown command suggests the one real command it is a typo of, and no command when two are as close", () => {
    expect(closestWord("rnu", ["run", "runs", "show"])).toBe("run")
    expect(closestWord("shwo", ["run", "runs", "show"])).toBe("show")
    expect(closestWord("rus", ["run", "runs", "show"])).toBeNull()
    expect(closestWord("deploy", ["run", "runs", "show"])).toBeNull()
    expect(usageErrorText("unknown command: rnu", ["rnu"])).toContain("Did you mean orc run?")
  })

  test("every command the parser accepts has its own help entry instead of falling back to the overview", () => {
    const missing = invocations.filter((invocation) => {
      const parsed = accepted(words(invocation))
      const topic = helpTopic(invocation.path)
      return !parsed || topic === null || topic.path !== invocation.path.join(" ")
    })
    expect(missing).toEqual([])
  })

  test("every flag a parser takes appears in its command's usage instead of going undocumented, and the usage names no flag the parser refuses", () => {
    const drift = invocations.flatMap((invocation) => {
      const documented = documentedFlags(invocation)
      const taken = parserFlags.filter((flag) => parserTakesFlag(invocation, flag))
      const path = invocation.path.join(" ")
      return [
        ...taken.filter((flag) => !documented.includes(flag)).map((flag) => path + " takes " + flag + " but its usage omits it"),
        ...documented.filter((flag) => !taken.includes(flag)).map((flag) => path + " documents " + flag + " but its parser refuses it")
      ]
    })
    expect(drift).toEqual([])
  })

  test("every positional a parser takes has a slot in one of its usage lines instead of a missing or extra one", () => {
    const drift = invocations.flatMap((invocation) => {
      const slots = entryOf(invocation).usage.map(usageLineSlots)
      const taken = parserSlots(invocation)
      return slots.includes(taken) ? [] : [invocation.path.join(" ") + " takes " + String(taken) + " positionals, usage shows " + slots.join(" or ")]
    })
    expect(drift).toEqual([])
  })
})
