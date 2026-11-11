export interface ProcessRow {
  readonly ppid: number
  readonly command: string
}

export type ProcessTable = ReadonlyMap<number, ProcessRow>

export const parseProcessTable = (text: string): ProcessTable => {
  const rows = new Map<number, ProcessRow>()
  for (const line of text.split("\n")) {
    const [pid = "", ppid = "", ...words] = line.trim().split(/\s+/)
    if (/^\d+$/.test(pid) && /^\d+$/.test(ppid) && !rows.has(Number(pid))) {
      rows.set(Number(pid), { ppid: Number(ppid), command: words.join(" ") })
    }
  }
  return rows
}

// Postcondition: an empty last entry marks a pid the table does not hold.
export const ancestry = (table: ProcessTable, start: number): ReadonlyArray<string> => {
  const chain: Array<string> = []
  const seen = new Set<number>()
  let pid = start
  while (!seen.has(pid)) {
    seen.add(pid)
    const row = table.get(pid)
    chain.push(row?.command ?? "")
    if (row === undefined || row.ppid === 0) {
      break
    }
    pid = row.ppid
  }
  return chain
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const afterFirst = (text: string, marker: string): string => {
  const at = text.indexOf(marker)
  return at < 0 ? text : text.slice(at + marker.length)
}

const waiterMarker = "orc-heavy-wait "
const utilityWrap = "taskpolicy -c utility "

export const unwrapSlotCommand = (command: string): string => {
  const waited = command.includes(waiterMarker) ? afterFirst(afterFirst(command, waiterMarker), " ") : command
  return waited.startsWith(utilityWrap) ? waited.slice(utilityWrap.length) : waited
}

const isWaiterCommand = (command: string): boolean => command.includes(waiterMarker)

const normalizeCommand = (command: string): string => command.replace(/["'\\]/g, "").replace(/ {2,}/g, " ").replace(/^ /, "")

const shellScript = /^(?:(?:sh|bash|dash|zsh) -c |.*\/(?:sh|bash) -c )/

const scriptOfShell = (command: string): string => (shellScript.test(command) ? afterFirst(command, " -c ") : command)

const pueueDaemons: ReadonlyArray<string> = ["pueue", "pueued"]

// Only calls a stand-in queued hold a slot. The stand-in itself matches a slot loosely, so only a pueue ancestor makes that match count.
export const insideSlot = (slotCommands: ReadonlyArray<string>, chain: ReadonlyArray<string>): boolean => {
  if (slotCommands.length === 0) {
    return false
  }
  const slots = slotCommands.filter(isWaiterCommand).map((command) => normalizeCommand(unwrapSlotCommand(command))).filter((command) => command !== "")
  let selfHit = false
  let ancestorHit = false
  let underPueue = false
  for (const [depth, raw] of chain.entries()) {
    const command = unwrapSlotCommand(raw)
    if (command === "") {
      return false
    }
    underPueue ||= pueueDaemons.includes(baseName(command.split(/\s+/)[0] ?? ""))
    const whole = normalizeCommand(command)
    const script = normalizeCommand(scriptOfShell(command))
    const hit = slots.some((slot) =>
      depth === 0 ? whole.includes(slot) || (whole !== "" && slot.includes(whole)) : slot === whole || slot === script
    )
    if (hit && depth === 0) {
      selfHit = true
    } else if (hit) {
      ancestorHit = true
    }
  }
  return ancestorHit || (selfHit && underPueue)
}

const throughShellMarker = ' -c "$@"; exit "$?" orc-heavy-through '

const wordsFollow = (words: ReadonlyArray<string>, at: number, expected: ReadonlyArray<string>): boolean =>
  expected.every((word, offset) => words[at + offset] === word)

const holderRunsWords = (command: string, holder: string, rest: ReadonlyArray<string>): boolean => {
  const words = command === "" ? [] : command.split(/ +/)
  if (baseName(words[0] ?? "") === holder && wordsFollow(words, 1, rest)) {
    return true
  }
  if (baseName(words[0] ?? "") === "") {
    return false
  }
  let at = 1
  while (at < words.length && (words[at] ?? "").startsWith("-")) {
    if (/^-[^-]*c/.test(words[at] ?? "")) {
      return false
    }
    at += 1
  }
  const script = baseName(words[at] ?? "")
  return at < words.length && (script === holder || script.replace(/\.[^.]*$/, "") === holder) && wordsFollow(words, at + 1, rest)
}

export const insideThrough = (through: ReadonlyArray<string>, chain: ReadonlyArray<string>): boolean => {
  const holder = baseName(through[0] ?? "")
  const restText = through.slice(1).join(" ")
  const rest = restText === "" ? [] : restText.split(/ +/)
  return chain.some((command) => command.includes(throughShellMarker) || holderRunsWords(command, holder, rest))
}
