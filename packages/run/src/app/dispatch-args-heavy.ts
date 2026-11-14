import { orList, parseJsonFlag, unexpected, type DispatchArgs } from "./dispatch-args-runner"

const heavySubcommands = {
  path: (extra: ReadonlyArray<string>): DispatchArgs => (extra.length === 0 ? { kind: "HeavyPath" } : unexpected(extra[0])),
  check: (extra: ReadonlyArray<string>): DispatchArgs => parseJsonFlag(extra, (json) => ({ kind: "HeavyCheck", json })),
  watch: (extra: ReadonlyArray<string>): DispatchArgs => (extra.length === 0 ? { kind: "HeavyWatch" } : unexpected(extra[0])),
  "watch-once": (extra: ReadonlyArray<string>): DispatchArgs => (extra.length === 0 ? { kind: "HeavyWatchOnce" } : unexpected(extra[0]))
} satisfies Record<string, (rest: ReadonlyArray<string>) => DispatchArgs>

export type HeavyWord = keyof typeof heavySubcommands
const isHeavyWord = (word: string): word is HeavyWord => Object.hasOwn(heavySubcommands, word)

export const parseHeavy = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [verb = "", ...extra] = rest
  return isHeavyWord(verb) ? heavySubcommands[verb](extra) : { kind: "UsageError", detail: "orc heavy takes " + orList(Object.keys(heavySubcommands)) + ", got \"" + verb + "\"" }
}
