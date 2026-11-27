import { Schema } from "effect"
import { tokenFileSource } from "./model-route"
import { ModelRef, type Provider, ProviderId } from "./orc-config"

export type ProviderRoom =
  | { readonly kind: "room" }
  | { readonly kind: "no-room"; readonly reason: string }

export const DefaultCredential = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("token-file"), tokenFile: Schema.optional(Schema.String), origin: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("claude-config"), configDir: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("only-account") })
])
export type DefaultCredential = typeof DefaultCredential.Type

export interface ReviewerCredential {
  readonly provider: string
  readonly credential: DefaultCredential
}

export type RoomReading = (reviewer: ReviewerCredential) => ProviderRoom

const WaitingReviewer = Schema.Struct({ provider: ProviderId, model: ModelRef, credential: DefaultCredential })

export const ReviewerWait = Schema.Struct({ reason: Schema.String, reviewers: Schema.NonEmptyArray(WaitingReviewer) })
export type ReviewerWait = typeof ReviewerWait.Type

export const reviewerWaitFileName = "reviewer-wait.json"

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
