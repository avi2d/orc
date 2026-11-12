import type { FailingMark } from "../agent/index"

export type Progress =
  | { readonly kind: "ended"; readonly action: BeatAction }
  | { readonly kind: "running"; readonly outputAt: string | null; readonly action: BeatAction | null; readonly failing: FailingMark | null }
  | { readonly kind: "own-log" }
  | { readonly kind: "untracked" }

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
    readonly outcome: "done" | "failed" | "stopped"
    readonly reason: string
    readonly pr: string | null
    readonly report: string | null
  }
  | { readonly kind: "split"; readonly task: string; readonly machine: string; readonly children: ReadonlyArray<string>; readonly reason: string }
  | { readonly kind: "close-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | {
    readonly kind: "parked"
    readonly task: string
    readonly machine: string
    readonly branch: string
    readonly questions: ReadonlyArray<string>
    readonly decider: ReadonlyArray<string>
  }
  | { readonly kind: "asking"; readonly task: string; readonly machine: string; readonly until: string; readonly questions: ReadonlyArray<string> }
  | { readonly kind: "answered"; readonly task: string; readonly machine: string; readonly questions: ReadonlyArray<string> }
  | { readonly kind: "answer-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | StalledAction
  | { readonly kind: "pr-unread"; readonly task: string; readonly reason: string }
  | { readonly kind: "attention"; readonly item: string; readonly task: string; readonly owner: "decider" | "user"; readonly overdue: boolean; readonly text: string }
  | { readonly kind: "upstream-seen"; readonly project: string; readonly url: string; readonly state: string }
  | { readonly kind: "upstream-changed"; readonly project: string; readonly url: string; readonly changes: ReadonlyArray<string>; readonly task: string }
  | { readonly kind: "upstream-unread"; readonly project: string; readonly url: string; readonly reason: string }
