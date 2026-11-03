export type StalledAction = { readonly kind: "stalled"; readonly task: string; readonly machine: string; readonly since: string }

export type BeatAction =
  | { readonly kind: "started"; readonly task: string; readonly machine: string; readonly account: string; readonly log: string }
  | { readonly kind: "start-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | { readonly kind: "lost"; readonly task: string }
  | { readonly kind: "given-back"; readonly task: string; readonly machine: string }
  | { readonly kind: "waits"; readonly task: string; readonly reason: string }
  | { readonly kind: "renewed"; readonly task: string; readonly machine: string }
  | { readonly kind: "renew-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | {
    readonly kind: "closed"
    readonly task: string
    readonly machine: string
    readonly outcome: "done" | "failed"
    readonly reason: string
    readonly pr: string | null
    readonly report: string | null
  }
  | { readonly kind: "close-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | { readonly kind: "parked"; readonly task: string; readonly machine: string; readonly branch: string; readonly questions: ReadonlyArray<string> }
  | StalledAction
  | { readonly kind: "pr-unread"; readonly task: string; readonly reason: string }
