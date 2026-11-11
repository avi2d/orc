import { constants } from "node:os"
import { classifyHeavyCall, decisionWords } from "./heavy-classify"
import { parseStandinCall, planCall, queueCall, type StandinCall } from "./heavy-standin-runtime"

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | number | null): number =>
  code ?? 128 + (signal === null ? 0 : typeof signal === "number" ? signal : constants.signals[signal])

type Env = Record<string, string | undefined>

const spawned = (argv: ReadonlyArray<string>, stdin: "inherit" | "ignore", env: Env) => {
  try {
    return Bun.spawn([...argv], { stdin, stdout: "inherit", stderr: "inherit", env })
  } catch {
    process.stderr.write("orc heavy: cannot start " + (argv[0] ?? "") + "\n")
    return null
  }
}

// A terminal sends INT and QUIT to the whole foreground group, so the child already has them; a second copy would force-quit tools that stop gracefully on the first.
const reraise: ReadonlySet<NodeJS.Signals> = new Set(["SIGTERM", "SIGHUP", "SIGINT", "SIGPIPE", "SIGKILL", "SIGUSR1", "SIGUSR2", "SIGALRM"])
const forwarded: ReadonlyArray<NodeJS.Signals> = ["SIGTERM", "SIGHUP"]
const groupWide: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGQUIT"]

export const runTool = async (argv: ReadonlyArray<string>, env: Env = process.env): Promise<number> => {
  const child = spawned(argv, "inherit", env)
  if (child === null) {
    return 127
  }
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal)
  }
  const ignore = (): void => {}
  for (const signal of forwarded) {
    process.on(signal, forward)
  }
  for (const signal of groupWide) {
    process.on(signal, ignore)
  }
  const code = await child.exited
  for (const signal of forwarded) {
    process.off(signal, forward)
  }
  for (const signal of groupWide) {
    process.off(signal, ignore)
  }
  if (typeof child.signalCode === "string" && reraise.has(child.signalCode)) {
    process.kill(process.pid, child.signalCode)
  }
  return exitCodeOf(code, child.signalCode)
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stops: ReadonlyArray<NodeJS.Signals> = ["SIGTERM", "SIGINT", "SIGHUP"]

// The queued call reads no input and ends once the stand-in that queued it is gone.
export const waitOwned = async (words: ReadonlyArray<string>): Promise<number> => {
  const [ownerWord = "", ...argv] = words
  const owner = Number(ownerWord)
  if (!Number.isInteger(owner) || owner <= 0 || argv.length === 0) {
    process.stderr.write("orc heavy: the queued task holds no owner and command\n")
    return 2
  }
  const child = spawned(argv, "ignore", process.env)
  if (child === null) {
    return 127
  }
  const stop = (): void => {
    child.kill()
  }
  for (const signal of stops) {
    process.on(signal, stop)
  }
  const watch = setInterval(() => {
    if (!alive(owner)) {
      stop()
    }
  }, 5000)
  const code = await child.exited
  clearInterval(watch)
  for (const signal of stops) {
    process.off(signal, stop)
  }
  return exitCodeOf(code, child.signalCode)
}

// The holder's parent stays in the process tree under this marker, because the stand-in's own command line reads the same whether it ran the call directly or through the holder.
const throughHold: ReadonlyArray<string> = ["sh", "-c", '"$@"; exit "$?"', "orc-heavy-through"]

const words = (text: string): ReadonlyArray<string> => text.split(/\s+/).filter((word) => word !== "")

const runCall = async (call: StandinCall, standin: string, args: ReadonlyArray<string>): Promise<number> => {
  const plan = planCall(call, standin, args)
  switch (plan.kind) {
    case "exit":
      return plan.code
    case "run":
      return runTool([plan.real, ...args])
    case "bypass":
      return runTool([plan.real, ...args], { ...process.env, HEAVY_QUEUE_BYPASSED: plan.reason })
    case "through":
      return runTool([...throughHold, ...(call.through ?? []), ...words(call.wrap), plan.real, ...args])
    case "queue":
      return queueCall(call, plan.real, args)
  }
}

export const runStandin = async (settings: string, rest: ReadonlyArray<string>): Promise<number> => {
  const call = parseStandinCall(settings)
  if (call === null) {
    process.stderr.write("orc heavy: the stand-in holds no readable call settings; rerun orc to rewrite it\n")
    return 2
  }
  const [standin = "", ...args] = rest
  if ((Bun.env.HEAVY_CLASSIFY ?? "") !== "") {
    process.stdout.write(decisionWords(classifyHeavyCall(call.tool, call.commands, args)) + "\n")
    return 0
  }
  return runCall(call, standin, args)
}
