import { DateTime, Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { type Account, type DispatchConfig, providerOf } from "../../shared/config/index"
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

export type Credential =
  | { readonly kind: "file"; readonly provider: string; readonly tokenFile: string }
  | { readonly kind: "token"; readonly provider: string; readonly token: RunToken }
  | { readonly kind: "none"; readonly provider: string }
  | { readonly kind: "claude-config"; readonly provider: string; readonly configDirs: Readonly<Record<string, string>> }

export const credentialFor = Effect.fnUntraced(function*(
  tokens: TokenCache,
  quota: DispatchConfig["quota"],
  account: Account
): Effect.fn.Return<Credential | { readonly kind: "waits"; readonly reason: string }, never, ChildProcessSpawner.ChildProcessSpawner> {
  const provider = providerOf(quota, account)
  switch (account.kind) {
    case "token-file": {
      return { kind: "file", provider, tokenFile: account.tokenFile }
    }
    case "claude-config": {
      return { kind: "claude-config", provider, configDirs: account.configDirs }
    }
    case "none": {
      return { kind: "none", provider }
    }
    case "token-command": {
      const check = yield* checkToken(tokens, account)
      return check.kind === "waits" ? check : { kind: "token", provider, token: check.token }
    }
  }
})
