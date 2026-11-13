import { DateTime, Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { type Account } from "../../shared/config/index"
import { readToken, type RunToken, tokenLive } from "../../entities/token/index"

export type TokenCheck = { readonly kind: "live"; readonly token: RunToken } | { readonly kind: "waits"; readonly reason: string }

// One beat reads each account's token once, so every start and renewal in it carries the same token.
export type TokenCache = Map<string, TokenCheck>

export const checkToken = (
  tokens: TokenCache,
  account: Extract<Account, { readonly kind: "token-command" }>
): Effect.Effect<TokenCheck, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const cached = tokens.get(account.name)
    if (cached !== undefined) {
      return cached
    }
    const reading = yield* readToken(account.tokenCommand)
    const now = yield* DateTime.now
    const check: TokenCheck = reading.kind === "unread"
      ? { kind: "waits", reason: "the token for " + account.name + " is unread: " + reading.reason }
      : tokenLive(reading.token.expiresAt, now)
      ? { kind: "live", token: reading.token }
      : { kind: "waits", reason: "the token for " + account.name + " runs out at " + DateTime.formatIso(reading.token.expiresAt) }
    tokens.set(account.name, check)
    return check
  })
