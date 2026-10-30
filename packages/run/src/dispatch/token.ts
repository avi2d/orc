import { Data, DateTime, Duration, Effect, Option, type Redacted, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TaskId } from "./backlog"
import type { Command } from "./config"

const TOKEN_JSON_SCHEMA = "orc.token.v1" as const

// Pi reads the key with cat and trims it, so a token holding a space or a line break would reach the provider cut.
const TokenValue = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,8192}$/)))

export const tokenFields = {
  token: TokenValue,
  expiresAt: Schema.DateTimeUtcFromString
}

const TokenDocument = Schema.Struct({ schema: Schema.Literal(TOKEN_JSON_SCHEMA), ...tokenFields })

export interface RunToken {
  readonly token: Redacted.Redacted
  readonly expiresAt: DateTime.Utc
}

export type TokenReading =
  | { readonly kind: "read"; readonly token: RunToken }
  | { readonly kind: "unread"; readonly reason: string }

const tokenSeconds = 15

// A run that starts this close to its token's end would lapse before its first answer.
const lapseMargin = Duration.minutes(5)

export const tokenLive = (expiresAt: DateTime.Utc, now: DateTime.Utc): boolean =>
  DateTime.isGreaterThan(expiresAt, DateTime.addDuration(now, lapseMargin))

// A decode failure carries the text it read, which may hold the token, so callers get only none.
export const decodeTokenText = (text: string): Option.Option<RunToken> =>
  Schema.decodeOption(Schema.fromJsonString(TokenDocument))(text, { onExcessProperty: "error" }).pipe(
    Option.map(({ token, expiresAt }) => ({ token, expiresAt }))
  )

export const tokenDocumentNote = "an " + TOKEN_JSON_SCHEMA + " document with a token and an expiresAt"

// An encode failure names the value it refused, which may be the token, so the error carries only what was encoded.
export class TokenEncodeError extends Data.TaggedError("TokenEncodeError")<{
  readonly what: string
}> {}

export const encodeSecretJson = <S extends Schema.Top & { readonly EncodingServices: never }>(schema: S, what: string) =>
  (value: S["Type"]): Effect.Effect<string, TokenEncodeError> =>
    Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(Effect.mapError(() => new TokenEncodeError({ what })))

export const encodeToken = (token: RunToken): Effect.Effect<string, TokenEncodeError> =>
  encodeSecretJson(TokenDocument, "token document")({ schema: TOKEN_JSON_SCHEMA, ...token })

export const LabelArg = Schema.NonEmptyString.check(Schema.isPattern(/^(?!\.{1,2}$).+$/))

export const RenewRequest = Schema.Struct({ task: TaskId, ...tokenFields, label: Schema.optional(LabelArg) })
export type RenewRequest = typeof RenewRequest.Type

export const encodeRenewal = encodeSecretJson(RenewRequest, "renewal")

// clauth stamps a profile's session-token.json in Claude Code's credentials shape, its expiry in epoch milliseconds.
const ClaudeSession = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: TokenValue,
    expiresAt: Schema.Int,
    refreshToken: Schema.optionalKey(Schema.Unknown)
  })
})

// A decode failure carries the text it read, which holds the token, so the reason names only what was missing.
export const sessionToken = (text: string): TokenReading => {
  const unread = (reason: string): TokenReading => ({ kind: "unread", reason })
  const session = Schema.decodeOption(Schema.fromJsonString(ClaudeSession))(text)
  if (Option.isNone(session)) {
    return unread("holds no Claude access token with an expiry")
  }
  const { accessToken, expiresAt, refreshToken } = session.value.claudeAiOauth
  if (refreshToken !== undefined) {
    return unread("holds a refresh token, so clauth has not armed it with rolling-token and its login would leave this machine")
  }
  return { kind: "read", token: { token: accessToken, expiresAt: DateTime.makeUnsafe(expiresAt) } }
}

export const readToken = (command: Command): Effect.Effect<TokenReading, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const [program, ...args] = command
  const unread = (why: string): TokenReading => ({ kind: "unread", reason: "the token command " + program + " " + why })
  return Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { stdin: "ignore", stderr: "ignore" }))
    const [stdout, exitCode] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return unread("exited " + exitCode)
    }
    return Option.match(decodeTokenText(stdout), {
      onNone: () => unread("printed no " + tokenDocumentNote),
      onSome: (token): TokenReading => ({ kind: "read", token })
    })
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: Duration.seconds(tokenSeconds), orElse: () => Effect.succeed(unread("ran past " + tokenSeconds + " seconds")) }),
    Effect.catch((error) => Effect.succeed(unread("did not run: " + error.message)))
  )
}
