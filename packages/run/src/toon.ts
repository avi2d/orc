const escapes: Readonly<Record<string, string>> = { "\\": "\\", "\"": "\"", n: "\n", r: "\r", t: "\t" }

export const trimmedLines = (output: string): Array<string> => output.split("\n").map((line) => line.trim())

const decode = (value: string): string => {
  const text = value.trim()
  const quoted = text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")
  return quoted ? text.slice(1, -1).replace(/\\(.)/g, (_, char: string) => escapes[char] ?? char) : text
}

export const scalar = (output: string, key: string): string => {
  const line = trimmedLines(output).find((candidate) => candidate.startsWith(key + ":"))
  return line === undefined ? "" : decode(line.slice(key.length + 1))
}

export const splitRow = (row: string): Array<string> => {
  const cells: Array<string> = []
  let cell = ""
  let quoted = false
  let escaped = false
  for (const char of row.trim()) {
    if (escaped) {
      escaped = false
    } else if (quoted && char === "\\") {
      escaped = true
    } else if (char === "\"") {
      quoted = !quoted
    } else if (char === "," && !quoted) {
      cells.push(cell)
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells.map(decode)
}

const tableHeader = (name: string): RegExp => new RegExp("^" + name + "\\[(\\d+)\\]\\{([^}]*)\\}:$")

export const hasTable = (output: string, name: string): boolean => trimmedLines(output).some((line) => tableHeader(name).test(line))

export const table = (output: string, name: string): ReadonlyArray<ReadonlyMap<string, string>> => {
  const lines = trimmedLines(output)
  const header = tableHeader(name)
  const headerIndex = lines.findIndex((line) => header.test(line))
  const match = header.exec(lines[headerIndex] ?? "")
  if (match === null) {
    return []
  }
  const columns = match[2].split(",").map((column) => column.trim())
  const rows = lines.slice(headerIndex + 1).filter((line) => line !== "").slice(0, Number(match[1]))
  return rows.map((row) => {
    const cells = splitRow(row)
    return new Map(columns.map((column, index) => [column, cells[index] ?? ""]))
  })
}
