import { setShared, shared } from "herdr"
import { type Guard, fields } from "./guard"
import { type Reading, readText } from "./orc-read"
import type { Refreshed } from "./views"

type Saved<A> = { readonly kind: "ok"; readonly value: A; readonly at: number; readonly refreshError?: string }
type Timed<A> = Saved<A> | Exclude<Reading<A>, { kind: "ok" }>

const saved = <A>(doc: unknown, guard: Guard<A>): Saved<A> | null => {
  const record = fields(doc, "")
  if (record.kind === "refused") return null
  const generatedAt = record.value["generatedAt"]
  const at = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN
  if (!Number.isFinite(at)) return null
  const reading = guard(record.value, "")
  return reading.kind === "ok" ? { kind: "ok", value: reading.value, at } : null
}

export const resourceReading = <A>(report: string, guard: Guard<A>): Refreshed<Timed<A>> => {
  const key = "orc.resources." + report
  let last = saved(shared(key), guard)
  const failed = (reason: string): Timed<A> => last === null ? { kind: "failed", reason } : { ...last, refreshError: reason }
  return {
    lastRead: 0, busy: false, reading: last ?? { kind: "reading" },
    load: async () => {
      const result = await readText("orc-dash", ["report", report])
      if (result.kind !== "ok") return result.kind === "failed" ? failed(result.reason) : result
      let doc: unknown
      try { doc = JSON.parse(result.value) } catch { return failed(`orc-dash report ${report} printed invalid JSON`) }
      const reading = saved(doc, guard)
      if (reading === null) return failed(`orc-dash report ${report} printed an invalid report`)
      setShared(key, doc)
      last = reading
      return reading
    }
  }
}

export const readingTime = <A>(host: Refreshed<Timed<A>>): string | null => {
  if (host.reading.kind !== "ok") return null
  const shown = "Read " + new Date(host.reading.at).toLocaleString()
  if (host.busy) return shown + ". Refreshing…"
  return host.reading.refreshError === undefined ? shown : shown + ". Refresh failed: " + host.reading.refreshError
}
