import { setShared, shared } from "herdr"
import { type Guard, type Guarded, fields, ok, refused } from "./guard"
import { type Reading, readText } from "./orc-read"
import type { Refreshed } from "./views"

type Saved<A> = { readonly kind: "ok"; readonly value: A; readonly at: number; readonly refreshError?: string }
type Timed<A> = Saved<A> | Exclude<Reading<A>, { kind: "ok" }>

const saved = <A>(doc: unknown, guard: Guard<A>): Guarded<Saved<A>> => {
  const record = fields(doc, "")
  if (record.kind === "refused") return record
  const generatedAt = record.value["generatedAt"]
  const at = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN
  if (!Number.isFinite(at)) return refused("generatedAt", "a date and time", generatedAt)
  const reading = guard(record.value, "")
  return reading.kind === "ok" ? ok({ kind: "ok", value: reading.value, at }) : reading
}

const savedOrNull = <A>(doc: unknown, guard: Guard<A>): Saved<A> | null => {
  const reading = saved(doc, guard)
  return reading.kind === "ok" ? reading.value : null
}

export const resourceReading = <A>(report: string, guard: Guard<A>): Refreshed<Timed<A>> => {
  const key = "orc.resources." + report
  let last = savedOrNull(shared(key), guard)
  const failed = (reason: string): Timed<A> => last === null ? { kind: "failed", reason } : { ...last, refreshError: reason }
  return {
    lastRead: 0, busy: false, reading: last ?? { kind: "reading" },
    load: async () => {
      const result = await readText("orc-dash", ["report", report])
      if (result.kind !== "ok") return result.kind === "failed" ? failed(result.reason) : result
      let doc: unknown
      try { doc = JSON.parse(result.value) } catch { return failed(`orc-dash report ${report} printed invalid JSON`) }
      const reading = saved(doc, guard)
      if (reading.kind === "refused") return failed(`orc-dash report ${report} printed a report this view cannot read: ${reading.reason}`)
      setShared(key, doc)
      last = reading.value
      return reading.value
    }
  }
}

export const readingTime = <A>(host: Refreshed<Timed<A>>): string | null => {
  if (host.reading.kind !== "ok") return null
  const shown = "Read " + new Date(host.reading.at).toLocaleString()
  if (host.busy) return shown + ". Refreshing…"
  return host.reading.refreshError === undefined ? shown : shown + ". Refresh failed: " + host.reading.refreshError
}
