import { Schema } from "effect"
import { tokenFileSource } from "./model-route"
import type { Provider } from "./orc-config"

export const ProviderRoom = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("room") }),
  Schema.Struct({ kind: Schema.Literal("no-room"), reason: Schema.String })
])
export type ProviderRoom = typeof ProviderRoom.Type

export type DefaultCredential =
  | { readonly kind: "token-file"; readonly tokenFile: string | undefined; readonly origin: string }
  | { readonly kind: "claude-config"; readonly configDir: string }
  | { readonly kind: "only-account" }

export interface ReviewerCredential {
  readonly provider: string
  readonly credential: DefaultCredential
}

export type RoomReading = (reviewer: ReviewerCredential) => ProviderRoom

export const defaultCredentialOf = (provider: Provider, env: Readonly<Record<string, string | undefined>>, configFile: string): DefaultCredential => {
  switch (provider.credential) {
    case "token-file": {
      const source = tokenFileSource(provider.tokenFile, undefined, env, configFile)
      return { kind: "token-file", tokenFile: source.path, origin: source.origin }
    }
    case "package": {
      const configDir = provider.env?.["CLAUDE_CONFIG_DIR"]
      return configDir === undefined ? { kind: "only-account" } : { kind: "claude-config", configDir }
    }
    case "pi-login":
      return { kind: "only-account" }
  }
}
