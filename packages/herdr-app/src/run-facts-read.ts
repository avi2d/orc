import { show } from "./guard"
import { readJson } from "./orc-read"
import { type RunFacts, runFacts } from "./run-agent"

const showsAtOnce = 4

export const readRunFacts = (wanted: ReadonlyArray<string>, facts: Map<string, RunFacts | null>, notify: () => void): Promise<void> => {
  const label = (runId: string): Promise<void> =>
    readJson("orc", ["show", runId, "--json"], show).then((reading) => {
      if (reading.kind === "ok") {
        facts.set(runId, runFacts(reading.value))
      }
    })
  const from = (start: number): Promise<void> =>
    start >= wanted.length
      ? Promise.resolve()
      : Promise.all(wanted.slice(start, start + showsAtOnce).map(label)).then(() => {
        notify()
        return from(start + showsAtOnce)
      })
  return from(0)
}
