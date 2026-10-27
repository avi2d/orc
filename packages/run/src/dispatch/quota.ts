import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

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
  readonly accounts: ReadonlyArray<string>
  readonly floorPercent: number
}

const ClauthWindow = Schema.Struct({
  label: Schema.String,
  utilization_pct: Schema.optional(Schema.NullOr(Schema.Finite))
})

const ClauthProfile = Schema.Struct({
  name: Schema.String,
  auth_status: Schema.optional(Schema.NullOr(Schema.String)),
  fetch_status: Schema.optional(Schema.NullOr(Schema.String)),
  stale: Schema.optional(Schema.NullOr(Schema.Boolean)),
  windows: Schema.optional(Schema.NullOr(Schema.Array(ClauthWindow)))
})
type ClauthProfile = typeof ClauthProfile.Type

const ClauthStatus = Schema.Struct({ profiles: Schema.Array(ClauthProfile) })

const clauthSeconds = 15

const utilization = (profile: ClauthProfile, label: string): number | null =>
  profile.windows?.find((window) => window.label === label)?.utilization_pct ?? null

const readAccount = (profile: ClauthProfile | undefined, account: string): AccountReading => {
  const unusable = (reason: string): AccountReading => ({ account, kind: "unusable", reason })
  if (profile === undefined) {
    return unusable("clauth has no profile " + account)
  }
  if (profile.auth_status !== "ok") {
    return unusable("clauth reports auth " + (profile.auth_status ?? "unknown"))
  }
  if (profile.fetch_status === "Failed") {
    return unusable("clauth could not read its usage")
  }
  if (profile.stale !== false) {
    return unusable("the clauth reading is stale")
  }
  const fiveHours = utilization(profile, "5h")
  const sevenDays = utilization(profile, "7d")
  if (fiveHours === null || sevenDays === null) {
    return unusable("the clauth reading lacks its 5h and 7d windows")
  }
  return { account, kind: "usable", remainingPercent: Math.min(100, Math.max(0, 100 - Math.max(fiveHours, sevenDays))) }
}

export const assessClauthStatus = (status: unknown, settings: QuotaSettings): QuotaReading => {
  const decoded = Schema.decodeUnknownOption(ClauthStatus)(status)
  if (Option.isNone(decoded)) {
    return { kind: "unread", reason: "clauth status --json printed no profile list" }
  }
  const accounts = settings.accounts.map((account) =>
    readAccount(decoded.value.profiles.find((profile) => profile.name === account), account)
  )
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
): Effect.Effect<QuotaReading, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("clauth", ["status", "--json"]))
    const [stdout, exitCode] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return { kind: "unread", reason: "clauth status --json exited " + exitCode } satisfies QuotaReading
    }
    const parsed = yield* Effect.try({ try: (): unknown => JSON.parse(stdout), catch: () => "clauth status --json printed no JSON" })
    return assessClauthStatus(parsed, settings)
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.seconds(clauthSeconds),
      orElse: () => Effect.fail("clauth status --json ran past " + clauthSeconds + " seconds")
    }),
    Effect.catch((error) =>
      Effect.succeed<QuotaReading>({ kind: "unread", reason: typeof error === "string" ? error : "clauth did not run: " + error.message })
    )
  )

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
