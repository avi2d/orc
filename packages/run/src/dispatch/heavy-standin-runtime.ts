import { accessSync, appendFileSync, closeSync, constants, mkdirSync, openSync, readSync, statSync } from "node:fs"
import { classifyHeavyCall } from "./heavy-classify"
import { ancestry, insideSlot, insideThrough, parseProcessTable } from "./heavy-process-tree"
import { exitCodeOf, queuedAhead, slotTasks, taskState, type TaskState } from "./heavy-pueue-task"

export const standinMarker = "Written by orc heavy path"

// Bun would otherwise load the caller's .env and bunfig.toml preloads into the stand-in.
export const helperCommand: ReadonlyArray<string> = [
  process.execPath, "--no-env-file", "--config=/dev/null", Bun.fileURLToPath(import.meta.resolve("./heavy-standin-main.ts"))
]

export const waiterWord = "orc-heavy-wait"

export interface StandinTiming {
  readonly budgetMinutes: number | null
  readonly pollSeconds: number
}

export interface StandinCall {
  readonly tool: string
  readonly commands: ReadonlyArray<string>
  readonly home: string
  readonly group: string
  readonly wrap: string
  readonly real: string
  readonly through: ReadonlyArray<string> | null
  readonly timing: StandinTiming | null
}

const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isTiming = (value: unknown): value is StandinTiming =>
  typeof value === "object" && value !== null && "budgetMinutes" in value && "pollSeconds" in value &&
  (value.budgetMinutes === null || typeof value.budgetMinutes === "number") && typeof value.pollSeconds === "number"

export const parseStandinCall = (text: string): StandinCall | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    typeof value !== "object" || value === null || !("tool" in value) || !("commands" in value) || !("home" in value) ||
    !("group" in value) || !("wrap" in value) || !("real" in value) || !("through" in value) || !("timing" in value)
  ) {
    return null
  }
  const { tool, commands, home, group, wrap, real, through, timing } = value
  if (
    typeof tool !== "string" || !isStrings(commands) || typeof home !== "string" || typeof group !== "string" ||
    typeof wrap !== "string" || typeof real !== "string" || !(through === null || isStrings(through)) ||
    !(timing === null || isTiming(timing))
  ) {
    return null
  }
  return { tool, commands, home, group, wrap, real, through, timing }
}

const sameFile = (left: string, right: string): boolean => {
  try {
    const a = statSync(left)
    const b = statSync(right)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return !statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isStandin = (path: string): boolean => {
  try {
    const handle = openSync(path, "r")
    const head = Buffer.alloc(4096)
    const read = readSync(handle, head, 0, head.length, 0)
    closeSync(handle)
    return head.subarray(0, read).toString("utf8").split("\n").slice(0, 2).join(" ").includes(standinMarker)
  } catch {
    return false
  }
}

// The shell's field split on ":" keeps empty inner fields as "." and drops a trailing empty field.
export const callerTool = (tool: string, pathValue: string, standin: string): string => {
  const entries = pathValue.split(":")
  if (entries.at(-1) === "") {
    entries.pop()
  }
  for (const entry of entries) {
    const candidate = (entry === "" ? "." : entry) + "/" + tool
    if (!sameFile(candidate, standin) && isExecutableFile(candidate) && !isStandin(candidate)) {
      return candidate
    }
  }
  return ""
}

const unloggable = /[\n\r\t"\\]/g

export const bypassLine = (reason: string, command: string, at: Date): string =>
  JSON.stringify({
    rule: "heavy-bypass",
    at: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    reason: reason.replaceAll(unloggable, ""),
    command: command.replaceAll(unloggable, "")
  })

const logBypass = (call: StandinCall, reason: string, args: ReadonlyArray<string>): void => {
  const alerts = call.home + "/backlog/alerts.jsonl"
  try {
    mkdirSync(call.home + "/backlog", { recursive: true })
  } catch {}
  try {
    appendFileSync(alerts, bypassLine(reason, [call.tool, ...args].join(" "), new Date()) + "\n")
  } catch {
    process.stderr.write("orc heavy: cannot write the bypass log at " + alerts + "\n")
  }
}

const capture = (argv: ReadonlyArray<string>): string | null => {
  try {
    const child = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "ignore" })
    return child.exitCode === 0 ? child.stdout.toString() : null
  } catch {
    return null
  }
}

const quietly = (argv: ReadonlyArray<string>): void => {
  capture(argv)
}

const processChain = (): ReadonlyArray<string> | null => {
  const table = capture(["ps", "-ww", "-eo", "pid,ppid,command"])
  return table === null ? null : ancestry(parseProcessTable(table), process.pid)
}

const callInsideSlot = (group: string): boolean => {
  const status = capture(["pueue", "status", "--json", "-g", group])
  const commands = status === null ? [] : slotTasks(status).map((task) => task.command)
  const chain = commands.length === 0 ? null : processChain()
  return chain !== null && insideSlot(commands, chain)
}

export type StandinPlan =
  | { readonly kind: "run" | "through" | "queue"; readonly real: string }
  | { readonly kind: "bypass"; readonly real: string; readonly reason: string }
  | { readonly kind: "exit"; readonly code: number }

const refuse = (message: string): StandinPlan => {
  process.stderr.write("orc heavy: " + message + "\n")
  return { kind: "exit", code: 127 }
}

export const planCall = (call: StandinCall, standin: string, args: ReadonlyArray<string>): StandinPlan => {
  const real = callerTool(call.tool, Bun.env.PATH ?? "", standin) || call.real
  if (real === "") {
    return refuse("no " + call.tool + " found when the stand-in was written")
  }
  if (!isExecutableFile(real) || sameFile(real, standin)) {
    return refuse("no " + call.tool + " at " + real)
  }
  if (classifyHeavyCall(call.tool, call.commands, args) === "direct") {
    return { kind: "run", real }
  }
  const bypass = Bun.env.HEAVY_QUEUE_BYPASS ?? ""
  if (bypass !== "") {
    if (Bun.env.HEAVY_QUEUE_BYPASSED !== bypass) {
      logBypass(call, bypass, args)
    }
    process.stderr.write("orc heavy: bypassing the " + call.group + " queue: " + bypass + "\n")
    return { kind: "bypass", real, reason: bypass }
  }
  if (call.through !== null) {
    const chain = processChain()
    return { kind: chain !== null && insideThrough(call.through, chain) ? "run" : "through", real }
  }
  return { kind: callInsideSlot(call.group) ? "run" : "queue", real }
}


const repairHint = "repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>"

const fail = (message: string): number => {
  process.stderr.write("orc heavy: " + message + "\n")
  return 1
}

// sh keeps an inherited PWD only while it still names the working directory.
const workingDirectory = (): string => {
  const logical = Bun.env.PWD ?? ""
  return logical.startsWith("/") && sameFile(logical, ".") ? logical : process.cwd()
}

const stateOf = async (id: number): Promise<TaskState> => {
  try {
    const child = Bun.spawn(["pueue", "log", "--json", String(id)], { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(child.stdout).text()
    return (await child.exited) === 0 ? taskState(text, id) : { status: "unknown" }
  } catch {
    return { status: "unknown" }
  }
}

const removeTask = (id: number): void => {
  const status = capture(["pueue", "log", "--json", String(id)])
  if (status !== null && taskState(status, id).status === "Running") {
    quietly(["pueue", "kill", String(id)])
    quietly(["pueue", "wait", "-q", String(id)])
  }
  quietly(["pueue", "remove", String(id)])
}

const aheadOf = (group: string, id: number): number => queuedAhead(slotTasks(capture(["pueue", "status", "--json", "-g", group]) ?? ""), id)

const placeLine = (group: string, id: number, state: TaskState, elapsed: number): string | null => {
  switch (state.status) {
    case "Queued":
      return "waiting " + String(elapsed) + "s for the " + group + " queue, " + String(aheadOf(group, id)) + " queued ahead in " + group
    case "Running":
      return "running " + String(elapsed) + "s in the " + group + " queue"
    case "Paused":
    case "Stashed":
    case "Locked":
      return state.status.toLowerCase() + " " + String(elapsed) + "s in the " + group + " queue"
    case "Done":
    case "unknown":
      return null
  }
}

const defaultTiming = (): StandinTiming => ({ budgetMinutes: Bun.env.GITHUB_ACTIONS === "true" ? 30 : null, pollSeconds: 60 })

const outOfBudget = (call: StandinCall, budgetMinutes: number | null, id: number, elapsed: number, now: TaskState): number | null => {
  if (budgetMinutes === null || elapsed < budgetMinutes * 60 || now.status !== "Queued") {
    return null
  }
  const ahead = aheadOf(call.group, id)
  removeTask(id)
  return fail("waited " + String(budgetMinutes) + " min for the heavy queue, " + String(ahead) + " ahead in " + call.group)
}

const pollTurn = (call: StandinCall, budgetMinutes: number | null, id: number, elapsed: number, report: boolean): number | null => {
  const now = taskState(capture(["pueue", "log", "--json", String(id)]) ?? "", id)
  const spent = outOfBudget(call, budgetMinutes, id, elapsed, now)
  const place = spent === null && report ? placeLine(call.group, id, now, elapsed) : null
  if (place !== null) {
    process.stderr.write("orc heavy: " + place + "\n")
  }
  return spent
}

const waitForTurn = async (call: StandinCall, id: number): Promise<number | null> => {
  const timing = call.timing ?? defaultTiming()
  const poll = Number.isInteger(timing.pollSeconds) && timing.pollSeconds > 0 ? timing.pollSeconds : 60
  let elapsed = 0
  let misses = 0
  for (;;) {
    const state = await stateOf(id)
    if (state.status === "Done") {
      return null
    }
    misses = state.status === "unknown" ? misses + 1 : 0
    if (misses >= 3) {
      removeTask(id)
      return fail("pueue lost the queued task; " + repairHint)
    }
    await Bun.sleep(1000)
    elapsed += 1
    if (elapsed % poll !== 0) {
      continue
    }
    const spent = pollTurn(call, timing.budgetMinutes, id, elapsed, elapsed % (poll * 3) === 0)
    if (spent !== null) {
      return spent
    }
  }
}

const interrupts: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"]

export const queueCall = async (call: StandinCall, real: string, args: ReadonlyArray<string>): Promise<number> => {
  if (capture(["pueue", "group", "--json"]) === null) {
    return fail("pueue is unreachable; " + repairHint)
  }
  const priority = classifyHeavyCall(call.tool, call.commands, args) === "prioritized" ? ["-o", "1"] : []
  const wrap = call.wrap.split(/\s+/).filter((word) => word !== "")
  let added: ReturnType<typeof Bun.spawnSync>
  try {
    added = Bun.spawnSync(
      [
        "pueue", "add", "--group", call.group, ...priority, "--working-directory", workingDirectory(), "--print-task-id", "--escape", "--",
        ...helperCommand, waiterWord, String(process.pid), ...wrap, real, ...args
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
  } catch {
    return fail("pueue refused the task; " + repairHint)
  }
  const reply = ((added.stdout?.toString() ?? "") + (added.stderr?.toString() ?? "")).replace(/\n+$/, "")
  if (added.exitCode !== 0) {
    return fail("pueue refused the task; " + repairHint)
  }
  if (!/^\d+$/.test(reply)) {
    return fail("pueue refused the task: " + reply)
  }
  const id = Number(reply)
  const interrupted = (): void => {
    removeTask(id)
    process.exit(130)
  }
  for (const signal of interrupts) {
    process.on(signal, interrupted)
  }
  const failed = await waitForTurn(call, id)
  for (const signal of interrupts) {
    process.off(signal, interrupted)
  }
  if (failed !== null) {
    return failed
  }
  try {
    await Bun.spawn(["pueue", "follow", String(id)], { stdin: "inherit", stdout: "inherit", stderr: "ignore" }).exited
  } catch {
    return fail("pueue is unreachable; " + repairHint)
  }
  const result = taskState(capture(["pueue", "log", "--json", String(id)]) ?? "", id)
  quietly(["pueue", "remove", String(id)])
  return exitCodeOf(result)
}
