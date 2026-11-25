import { Result, Schema } from "effect"
import { duplicateOf } from "../../shared/config/index"
import type { AccountReading } from "./quota-command"

const SUBQUO_VERSION = "subquo.v1" as const

const Timestamp = Schema.String.check(Schema.makeFilter((value) => {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}))
const Label = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))
const FailureCode = Schema.Literals(["timeout", "rate_limited", "auth_required", "auth_unverified"])
const Window = Schema.Struct({
  id: Label,
  scope: Label,
  percentLeft: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resetsAt: Schema.NullOr(Timestamp)
})
type SubquoWindow = typeof Window.Type
type KnownWindow = SubquoWindow & { readonly percentLeft: number; readonly resetsAt: string }
const Windows = Schema.NonEmptyArray(Window)
const Observation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("fresh"), observedAt: Timestamp, source: Schema.Literal("provider"), validUntil: Timestamp, windows: Windows }),
  Schema.Struct({ status: Schema.Literal("stale"), observedAt: Timestamp, source: Schema.Literal("provider"), windows: Windows, code: Schema.NullOr(FailureCode) }),
  Schema.Struct({ status: Schema.Literal("unavailable"), code: FailureCode })
])
const SubquoSnapshot = Schema.Struct({
  version: Schema.Literal(SUBQUO_VERSION),
  writtenAt: Timestamp,
  accounts: Schema.Array(Schema.Struct({ id: Label, provider: Schema.String, observation: Observation }))
})
type SubquoSnapshot = typeof SubquoSnapshot.Type
type SubquoAccount = SubquoSnapshot["accounts"][number]

export type SubquoFailureCause = "schema" | "account-missing"

type SubquoRead =
  | { readonly kind: "ok"; readonly accounts: ReadonlyArray<AccountReading> }
  | { readonly kind: "error"; readonly cause: SubquoFailureCause; readonly reason: string }

const everyModel = "all"

const isKnown = (window: SubquoWindow): window is KnownWindow => window.percentLeft !== null && window.resetsAt !== null

export const isSubquoDocument = (document: unknown): boolean => typeof document === "object" && document !== null && "version" in document

const figureOf = (entry: SubquoAccount, nowMillis: number): AccountReading => {
  const account = entry.id
  const observation = entry.observation
  if (observation.status === "unavailable") {
    return { account, kind: "unusable", reason: "subquo reads it unavailable: " + observation.code }
  }
  if (observation.status === "stale") {
    return { account, kind: "unusable", reason: "subquo's reading from " + observation.observedAt + " is stale" + (observation.code === null ? "" : ": " + observation.code) }
  }
  if (nowMillis >= Date.parse(observation.validUntil)) {
    return { account, kind: "unusable", reason: "subquo's reading from " + observation.observedAt + " went stale at " + observation.validUntil }
  }
  const limits = observation.windows.filter((window) => window.scope === everyModel)
  if (limits.length === 0) {
    return { account, kind: "unusable", reason: "subquo reads no window with scope " + everyModel }
  }
  const unknown = limits.find((window) => !isKnown(window))
  if (unknown !== undefined) {
    return { account, kind: "unusable", reason: "subquo reads an unknown percent or reset in the " + unknown.id + " window" }
  }
  // Tied limiting windows all hold the account at that percent, so room returns only when the last of them resets.
  const limiting = limits.filter(isKnown).reduce((held, window) =>
    window.percentLeft < held.percentLeft || (window.percentLeft === held.percentLeft && window.resetsAt > held.resetsAt) ? window : held
  )
  return { account, kind: "usable", remainingPercent: limiting.percentLeft, resetsAt: limiting.resetsAt }
}

export const decodeSubquo = (document: unknown, names: ReadonlyArray<string>, nowMillis: number): SubquoRead => {
  const decoded = Schema.decodeUnknownResult(SubquoSnapshot)(document, { errors: "all" })
  if (Result.isFailure(decoded)) {
    return { kind: "error", cause: "schema", reason: "the quota command printed no " + SUBQUO_VERSION + " snapshot: " + decoded.failure.message }
  }
  const entries = decoded.success.accounts
  const duplicate = duplicateOf(entries.map((entry) => entry.id))
  if (duplicate !== null) {
    return { kind: "error", cause: "schema", reason: "the subquo snapshot names the account " + duplicate + " twice" }
  }
  const missing = names.filter((name) => !entries.some((entry) => entry.id === name))
  if (missing.length > 0) {
    return { kind: "error", cause: "account-missing", reason: "the subquo snapshot names no account " + missing.join(", ") + ", so its account list and the quota accounts differ" }
  }
  return { kind: "ok", accounts: names.flatMap((name) => entries.filter((entry) => entry.id === name).map((entry) => figureOf(entry, nowMillis))) }
}
