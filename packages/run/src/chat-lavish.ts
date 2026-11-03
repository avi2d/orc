import { Effect, Schema } from "effect"
import { networkInterfaces } from "node:os"
import { type Env, runCommand } from "./chat-command"
import { ChatToolError } from "./chat-error"
import { scalar, table } from "./toon"

export interface BoardPrompt {
  readonly tag: string
  readonly text: string
  readonly data: unknown
}

export type BoardPoll =
  | { readonly kind: "feedback"; readonly prompts: ReadonlyArray<BoardPrompt> }
  | { readonly kind: "waiting" }
  | { readonly kind: "closed"; readonly status: string }

interface BoardSession {
  readonly url: string
  readonly networkWarning: string
}

export interface BoardLauncher {
  readonly open: (file: string) => Effect.Effect<BoardSession, ChatToolError>
  readonly poll: (file: string) => Effect.Effect<BoardPoll, ChatToolError>
  readonly reply: (file: string, text: string) => Effect.Effect<void, ChatToolError>
  readonly end: (file: string) => Effect.Effect<void, ChatToolError>
}

const boardHostVar = "ORC_BOARD_HOST"
const lavishHostVar = "LAVISH_AXI_HOST"
const loopbackHost = "127.0.0.1"

interface BoardInterface {
  readonly address: string
  readonly family: string | number
  readonly internal: boolean
}

const tailnetAddress = (address: string): boolean => {
  const parts = address.split(".").map(Number)
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

const rankAddress = (address: string): number | null => {
  if (address.startsWith("192.168.")) {
    return 0
  }
  if (address.startsWith("10.")) {
    return 1
  }
  const second = Number(address.split(".")[1])
  if (address.startsWith("172.") && second >= 16 && second <= 31) {
    return 2
  }
  return null
}

export const pickBoardHost = (ifaces: Record<string, ReadonlyArray<BoardInterface> | undefined>): string | null => {
  const candidates = Object.values(ifaces).flat().filter((info): info is BoardInterface =>
    info !== undefined && !info.internal && (info.family === "IPv4" || info.family === 4) && !tailnetAddress(info.address) && rankAddress(info.address) !== null)
  for (const rank of [0, 1, 2]) {
    const found = candidates.find((info) => rankAddress(info.address) === rank)
    if (found !== undefined) {
      return found.address
    }
  }
  return null
}

export const boardHostAddress = (env: Env, ifaces: Record<string, ReadonlyArray<BoardInterface> | undefined> = networkInterfaces()): string => {
  const override = env[boardHostVar]?.trim()
  if (override !== undefined && override !== "") {
    return override
  }
  return pickBoardHost(ifaces) ?? loopbackHost
}

const contextMarker = "\n\nContext data:\n"

const decodeData = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const promptData = (prompt: string): Effect.Effect<unknown> => {
  const cut = prompt.indexOf(contextMarker)
  return cut === -1 ? Effect.succeed(null) : decodeData(prompt.slice(cut + contextMarker.length)).pipe(Effect.orElseSucceed(() => null))
}

const promptsOf = (output: string): Effect.Effect<ReadonlyArray<BoardPrompt>> =>
  Effect.forEach(table(output, "prompts"), (row) =>
    promptData(row.get("prompt") ?? "").pipe(Effect.map((data) => ({ tag: row.get("tag") ?? "", text: row.get("text") ?? "", data }))))

const lavish = (args: ReadonlyArray<string>, env: Env): Effect.Effect<string, ChatToolError> =>
  runCommand(["lavish-axi", ...args], null, env)

export const lavishLauncher = (env: Env): BoardLauncher => {
  const full = { ...env, [lavishHostVar]: boardHostAddress(env) }
  return {
    open: (file) =>
      lavish([file, "--no-open", "--reopen"], full).pipe(
        Effect.flatMap((output): Effect.Effect<BoardSession, ChatToolError> => {
          const url = scalar(output, "url")
          return url === ""
            ? Effect.fail(new ChatToolError({ message: "lavish-axi opened no session for " + file + ": " + output }))
            : Effect.succeed({ url, networkWarning: scalar(output, "network_warning") })
        })
      ),
    poll: (file) =>
      lavish(["poll", file], full).pipe(
        Effect.flatMap((output): Effect.Effect<BoardPoll> => {
          const status = scalar(output, "status")
          if (status === "feedback") {
            return promptsOf(output).pipe(Effect.map((prompts) => ({ kind: "feedback", prompts })))
          }
          return Effect.succeed(status === "waiting" ? { kind: "waiting" } : { kind: "closed", status: status === "" ? "no status" : status })
        })
      ),
    reply: (file, text) => lavish(["reply", file, "--agent-reply", text], full).pipe(Effect.asVoid),
    end: (file) => lavish(["end", file], full).pipe(Effect.asVoid)
  }
}
