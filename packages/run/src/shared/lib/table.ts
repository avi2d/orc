export const formatTable = (header: ReadonlyArray<string>, body: ReadonlyArray<ReadonlyArray<string>>, empty: string): string => {
  if (body.length === 0) {
    return empty
  }
  const table: ReadonlyArray<ReadonlyArray<string>> = [header, ...body]
  const widths: Array<number> = []
  for (const row of table) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return table.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd())
    .join("\n")
}
