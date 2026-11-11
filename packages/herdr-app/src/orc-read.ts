import { exec } from "herdr"
import { type Guard, guardJson } from "./guard"

export type Reading<A> =
  | { readonly kind: "reading" }
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "failed"; readonly reason: string }

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

export const readJson = <A>(command: string, args: ReadonlyArray<string>, guard: Guard<A>): Promise<Reading<A>> => {
  const line = [command, ...args].join(" ")
  return exec(command, [...args]).then(
    (result): Reading<A> => {
      if (result.code !== 0) {
        return { kind: "failed", reason: `${line} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}` }
      }
      const guarded = guardJson(result.stdout, guard)
      return guarded.kind === "ok"
        ? { kind: "ok", value: guarded.value }
        : { kind: "failed", reason: `${line} printed a document this view cannot read: ${guarded.reason}` }
    },
    (): Reading<A> => ({ kind: "failed", reason: `Could not start ${command}. Check that it is on PATH.` })
  )
}
