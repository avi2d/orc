import { exec } from "herdr"
import { type Guard, guardJson } from "./guard"

export type Reading<A> =
  | { readonly kind: "reading" }
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "failed"; readonly reason: string }

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

export const readText = (command: string, args: ReadonlyArray<string>): Promise<Reading<string>> => {
  const line = [command, ...args].join(" ")
  return exec(command, [...args]).then(
    (result): Reading<string> =>
      result.code === 0
        ? { kind: "ok", value: result.stdout }
        : { kind: "failed", reason: `${line} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}` },
    (): Reading<string> => ({ kind: "failed", reason: `Could not start ${command}. Check that it is on PATH.` })
  )
}

export const readJson = <A>(command: string, args: ReadonlyArray<string>, guard: Guard<A>): Promise<Reading<A>> =>
  readText(command, args).then((reading): Reading<A> => {
    if (reading.kind !== "ok") {
      return reading
    }
    const guarded = guardJson(reading.value, guard)
    return guarded.kind === "ok"
      ? { kind: "ok", value: guarded.value }
      : { kind: "failed", reason: `${[command, ...args].join(" ")} printed a document this view cannot read: ${guarded.reason}` }
  })
