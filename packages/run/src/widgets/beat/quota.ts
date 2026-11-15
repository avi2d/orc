import { DateTime, Duration, Effect, Result, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { spawnedQuiet } from "../../shared/process/index"
import { duplicateOf } from "../../shared/config/index"

type AccountReading =
  | { readonly account: string; readonly kind: "usable"; readonly remainingPercent: number; readonly resetsAt?: string }
  | { readonly account: string; readonly kind: "unusable"; readonly reason: string }

export type QuotaReading =
  | { readonly kind: "unread"; readonly reason: string }
  | {
    readonly kind: "read"
    readonly floorPercent: number
    readonly accounts: ReadonlyArray<AccountReading>
    readonly pick: string | null
  }

export interface QuotaSettings {
  readonly command: readonly [string, ...Array<string>]
  readonly accounts: ReadonlyArray<{ readonly name: string }>
  readonly floorPercent: number
}

const QUOTA_JSON_SCHEMA = "orc.quota.v1" as const

const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

const QuotaAccount = Schema.Union([
  Schema.Struct({ name: Schema.String, remainingPercent: Percent }),
  Schema.Struct({ name: Schema.String, unusable: Schema.String })
])
type QuotaAccount = typeof QuotaAccount.Type

const QuotaDocument = Schema.Struct({ schema: Schema.Literal(QUOTA_JSON_SCHEMA), accounts: Schema.Array(QuotaAccount) })

const QuotaAxiProvider = Schema.Struct({
  provider: Schema.String,
  accountKey: Schema.optionalKey(Schema.String),
  accountKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  windows: Schema.Array(Schema.Struct({ id: Schema.String, resetsAt: Schema.optionalKey(Schema.DateTimeUtcFromString) })),
  state: Schema.optionalKey(Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.String) })),
  quotaSemantics: Schema.optionalKey(Schema.Struct({
    effectiveAvailability: Schema.Array(Schema.Struct({
      scope: Schema.String,
      effectivePercentRemaining: Schema.optionalKey(Percent),
      limitingWindowIds: Schema.optionalKey(Schema.Array(Schema.String))
    }))
  }))
})
type QuotaAxiProvider = typeof QuotaAxiProvider.Type

const QuotaAxiDocument = Schema.Struct({ schemaVersion: Schema.Finite, providers: Schema.Array(QuotaAxiProvider) })

const quotaSeconds = 15

const accountKeysOf = (entry: QuotaAxiProvider): ReadonlyArray<string> => [...new Set([...(entry.accountKey === undefined ? [] : [entry.accountKey]), ...(entry.accountKeys ?? [])])]

const readQuotaAxiAccount = (entry: QuotaAxiProvider | undefined, account: string): AccountReading => {
  if (entry === undefined) {
    return { account, kind: "unusable", reason: "the quota-axi document names no account key " + account }
  }
  const stateNote = entry.state?.error ?? (entry.state === undefined || entry.state.status === "fresh" ? "" : "its state is " + entry.state.status)
  const unusable = (reason: string): AccountReading => ({ account, kind: "unusable", reason: stateNote === "" ? reason : reason + ", " + stateNote })
  if (entry.windows.length === 0) {
    return unusable("quota-axi names no window for " + entry.provider)
  }
  const every = entry.quotaSemantics?.effectiveAvailability.find((availability) => availability.scope === "all_models")
  if (every?.effectivePercentRemaining === undefined) {
    return unusable("quota-axi reads no all_models remaining percent for " + entry.provider)
  }
  const limiting = every.limitingWindowIds ?? []
  const resets = entry.windows.flatMap((window) => limiting.includes(window.id) && window.resetsAt !== undefined ? [window.resetsAt] : [])
  // Tied limiting windows all hold the account at that percent, so room returns only when the last of them resets.
  const resetsAt = resets.reduce<DateTime.Utc | undefined>((latest, at) => latest === undefined || DateTime.isGreaterThan(at, latest) ? at : latest, undefined)
  return resetsAt === undefined
    ? { account, kind: "usable", remainingPercent: every.effectivePercentRemaining }
    : { account, kind: "usable", remainingPercent: every.effectivePercentRemaining, resetsAt: DateTime.formatIso(resetsAt) }
}

const assessQuotaAxi = (document: unknown, settings: QuotaSettings): QuotaReading | ReadonlyArray<AccountReading> => {
  const decoded = Schema.decodeUnknownResult(QuotaAxiDocument)(document, { errors: "all" })
  if (Result.isFailure(decoded)) {
    return { kind: "unread", reason: "the quota command printed no quota-axi --json document: " + decoded.failure.message }
  }
  const entries = decoded.success.providers
  if (entries.every((entry) => entry.windows.length === 0)) {
    return { kind: "unread", reason: "the quota-axi document names no window" }
  }
  const duplicate = duplicateOf(entries.flatMap(accountKeysOf))
  if (duplicate !== null) {
    return { kind: "unread", reason: "the quota-axi document names the account key " + duplicate + " twice" }
  }
  const [only] = entries
  return settings.accounts.map(({ name }) => {
    const named = entries.find((entry) => accountKeysOf(entry).includes(name))
    return readQuotaAxiAccount(named ?? (entries.length === 1 && settings.accounts.length === 1 ? only : undefined), name)
  })
}

const readAccount = (entry: QuotaAccount | undefined, account: string): AccountReading => {
  if (entry === undefined) {
    return { account, kind: "unusable", reason: "the quota command names no account " + account }
  }
  return "unusable" in entry
    ? { account, kind: "unusable", reason: entry.unusable }
    : { account, kind: "usable", remainingPercent: entry.remainingPercent }
}

const readAccounts = (document: unknown, settings: QuotaSettings): QuotaReading | ReadonlyArray<AccountReading> => {
  if (typeof document === "object" && document !== null && "providers" in document) {
    return assessQuotaAxi(document, settings)
  }
  // An entry naming both remainingPercent and unusable matches the first member unless excess keys fail it.
  const decoded = Schema.decodeUnknownResult(QuotaDocument)(document, { onExcessProperty: "error", errors: "all" })
  if (Result.isFailure(decoded)) {
    return { kind: "unread", reason: "the quota command printed no " + QUOTA_JSON_SCHEMA + " document: " + decoded.failure.message }
  }
  const duplicate = duplicateOf(decoded.success.accounts.map((entry) => entry.name))
  if (duplicate !== null) {
    return { kind: "unread", reason: "the quota command names the account " + duplicate + " twice" }
  }
  return settings.accounts.map(({ name }) => readAccount(decoded.success.accounts.find((entry) => entry.name === name), name))
}

export const assessQuota = (document: unknown, settings: QuotaSettings): QuotaReading => {
  const accounts = readAccounts(document, settings)
  if ("kind" in accounts) {
    return accounts
  }
  let pick: { readonly account: string; readonly remainingPercent: number } | null = null
  for (const reading of accounts) {
    if (reading.kind === "usable" && reading.remainingPercent > 0 && reading.remainingPercent >= settings.floorPercent && reading.remainingPercent > (pick?.remainingPercent ?? -1)) {
      pick = reading
    }
  }
  return { kind: "read", floorPercent: settings.floorPercent, accounts, pick: pick?.account ?? null }
}

export const readQuota = (
  settings: QuotaSettings
): Effect.Effect<QuotaReading, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const [program, ...args] = settings.command
  return Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [stdout, exitCode] = yield* spawnedQuiet(spawner, program, args)
    if (exitCode !== 0) {
      return { kind: "unread", reason: "the quota command " + program + " exited " + exitCode } satisfies QuotaReading
    }
    const parsed = yield* Effect.try({ try: (): unknown => JSON.parse(stdout), catch: () => "the quota command " + program + " printed no JSON" })
    return assessQuota(parsed, settings)
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.seconds(quotaSeconds),
      orElse: () => Effect.fail("the quota command " + program + " ran past " + quotaSeconds + " seconds")
    }),
    Effect.catch((error) =>
      Effect.succeed<QuotaReading>({ kind: "unread", reason: typeof error === "string" ? error : "the quota command " + program + " did not run: " + error.message })
    )
  )
}

export const describeQuota = (reading: QuotaReading): string => {
  if (reading.kind === "unread") {
    return "quota unread: " + reading.reason
  }
  const accounts = reading.accounts.map((account) =>
    account.kind === "usable"
      ? account.account + " " + account.remainingPercent + "% left" + (account.resetsAt === undefined ? "" : " until " + account.resetsAt)
      : account.account + " unusable, " + account.reason
  )
  const verdict = reading.pick === null ? "no account has room at or above the floor" : "runs use " + reading.pick
  return "quota: " + accounts.join(", ") + ", floor " + reading.floorPercent + "%: " + verdict
}
