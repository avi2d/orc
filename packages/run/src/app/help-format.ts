export interface HelpOption {
  readonly flag: string
  readonly meaning: string
}

export interface HelpEntry {
  readonly usage: ReadonlyArray<string>
  readonly summary: string
  readonly about: string
  readonly options: ReadonlyArray<HelpOption>
  readonly examples: ReadonlyArray<string>
}

export type Row = readonly [name: string, text: string]

export const terminalWidth = 80
const indent = "  "
const gap = 2
const widestName = 24

const wrapWords = (words: ReadonlyArray<string>, first: string, rest: string, width: number): Array<string> => {
  const lines: Array<string> = []
  let line = first
  let fresh = true
  for (const word of words) {
    if (!fresh && line.length + 1 + word.length > width) {
      lines.push(line)
      line = rest + word
      continue
    }
    line = fresh ? line + word : line + " " + word
    fresh = false
  }
  lines.push(line)
  return lines
}

export const wrap = (text: string, width: number, lead = "", hang = lead): Array<string> =>
  wrapWords(text.split(" ").filter((word) => word !== ""), lead, hang, width)

// A bracketed or angled group such as [--until <YYYY-MM-DD>] holds spaces and must not break across lines.
const usageTokens = (line: string): Array<string> => {
  const tokens: Array<string> = []
  let token = ""
  let depth = 0
  for (const char of line) {
    if (char === " " && depth === 0) {
      if (token !== "") {
        tokens.push(token)
      }
      token = ""
      continue
    }
    depth += char === "[" || char === "<" ? 1 : char === "]" || char === ">" ? -1 : 0
    token += char
  }
  return token === "" ? tokens : [...tokens, token]
}

const usagePrefix = "Usage: "

export const usageBlock = (usage: ReadonlyArray<string>, width = terminalWidth): Array<string> =>
  usage.flatMap((line, index) => {
    const lead = index === 0 ? usagePrefix : " ".repeat(usagePrefix.length)
    return wrapWords(usageTokens(line), lead, " ".repeat(usagePrefix.length + 4), width)
  })

const nameWidth = (rows: ReadonlyArray<Row>): number =>
  Math.min(widestName, Math.max(0, ...rows.map(([name]) => name.length)))

const table = (rows: ReadonlyArray<Row>, column: number, width = terminalWidth): Array<string> =>
  rows.flatMap(([name, text]) => {
    const hang = " ".repeat(indent.length + column + gap)
    if (name.length > column) {
      return [indent + name, ...wrap(text, width, hang)]
    }
    return wrap(text, width, indent + name.padEnd(column + gap), hang)
  })

export interface OverviewGroup {
  readonly group: string
  readonly rows: ReadonlyArray<Row>
}

export const formatOverview = (about: string, listed: ReadonlyArray<OverviewGroup>, width = terminalWidth): string => {
  const column = nameWidth(listed.flatMap((entry) => entry.rows))
  return [
    ...wrap(about, width),
    "",
    ...usageBlock(["orc <command> [<args>]", "orc --help | --version"], width),
    ...listed.flatMap((entry) => ["", entry.group, ...table(entry.rows, column, width)]),
    "",
    ...wrap("Run orc <command> --help to learn what a command does and the options it takes.", width)
  ].join("\n")
}

const section = (title: string, lines: ReadonlyArray<string>): Array<string> =>
  lines.length === 0 ? [] : ["", title, ...lines]

export const formatHelp = (path: string, entry: HelpEntry, children: ReadonlyArray<Row>, width = terminalWidth): string => {
  const options = entry.options.map((option): Row => [option.flag, option.meaning])
  return [
    ...usageBlock(entry.usage, width),
    "",
    ...wrap(entry.about, width),
    ...section("Subcommands:", table(children, nameWidth(children), width)),
    ...section("Options:", table(options, nameWidth(options), width)),
    ...section("Examples:", entry.examples.flatMap((example) => wrap(example, width, indent, indent + "    "))),
    ...(children.length === 0 ? [] : ["", ...wrap("Run orc " + path + " <subcommand> --help for one subcommand.", width)])
  ].join("\n")
}
