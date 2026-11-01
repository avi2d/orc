import { Duration, Effect, Result, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { duplicateOf } from "../json-file"

type AccountReading =
  | { readonly account: string; readonly kind: "usable"; readonly remainingPercent: number }
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

const QuotaAccount = Schema.Union([
  Schema.Struct({ name: Schema.String, remainingPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })) }),
  Schema.Struct({ name: Schema.String, unusable: Schema.String })
])
type QuotaAccount = typeof QuotaAccount.Type

const QuotaDocument = Schema.Struct({ schema: Schema.Literal(QUOTA_JSON_SCHEMA), accounts: Schema.Array(QuotaAccount) })

const quotaSeconds = 15

const readAccount = (entry: QuotaAccount | undefined, account: string): AccountReading => {
  if (entry === undefined) {
    return { account, kind: "unusable", reason: "the quota command names no account " + account }
  }
  return "unusable" in entry
    ? { account, kind: "unusable", reason: entry.unusable }
    : { account, kind: "usable", remainingPercent: entry.remainingPercent }
}

export const assessQuota = (document: unknown, settings: QuotaSettings): QuotaReading => {
  // An entry naming both remainingPercent and unusable matches the first member unless excess keys fail it.
  const decoded = Schema.decodeUnknownResult(QuotaDocument)(document, { onExcessProperty: "error", errors: "all" })
  if (Result.isFailure(decoded)) {
    return { kind: "unread", reason: "the quota command printed no " + QUOTA_JSON_SCHEMA + " document: " + decoded.failure.message }
  }
  const duplicate = duplicateOf(decoded.success.accounts.map((entry) => entry.name))
  if (duplicate !== null) {
    return { kind: "unread", reason: "the quota command names the account " + duplicate + " twice" }
  }
  const accounts = settings.accounts.map(({ name }) => readAccount(decoded.success.accounts.find((entry) => entry.name === name), name))
  let pick: { readonly account: string; readonly remainingPercent: number } | null = null
  for (const reading of accounts) {
    if (reading.kind === "usable" && reading.remainingPercent >= settings.floorPercent && reading.remainingPercent > (pick?.remainingPercent ?? -1)) {
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
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { stdin: "ignore", stderr: "ignore" }))
    const [stdout, exitCode] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], { concurrency: "unbounded" })
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
    account.kind === "usable" ? account.account + " " + account.remainingPercent + "% left" : account.account + " unusable, " + account.reason
  )
  const verdict = reading.pick === null ? "no account is at or above the floor" : "runs use " + reading.pick
  return "quota: " + accounts.join(", ") + ", floor " + reading.floorPercent + "%: " + verdict
}
