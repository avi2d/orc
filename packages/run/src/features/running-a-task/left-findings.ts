import type { ReviewFinding } from "./review-outcome"

export const passesRoundTwoBar = (finding: ReviewFinding): boolean => finding.severity === "error"

export type ReviewStop = "cleared" | "round-limit" | "repeat" | "severity-bar"

const stopReasons = {
  cleared: "no fixable error or warning remained",
  "round-limit": "the configured fix round limit was reached",
  repeat: "a finding repeated one sent to the fixer",
  "severity-bar": "no finding met the later rounds' severity bar"
} satisfies Record<ReviewStop, string>

export const reviewStopReason = (stop: ReviewStop): string => stopReasons[stop]

type LeftReason =
  | { readonly kind: "below-round-2-bar" }
  | { readonly kind: "repeat"; readonly round: number }
  | { readonly kind: "round-limit"; readonly round: number }
  | { readonly kind: "ask-user" }
  | { readonly kind: "stopped"; readonly stop: ReviewStop }

export interface LeftFinding {
  readonly finding: ReviewFinding
  readonly reason: LeftReason
}

export const sameFinding = (one: ReviewFinding, other: ReviewFinding): boolean =>
  one.file === other.file && "topic" in one && "topic" in other && one.topic === other.topic

export const leftFindings = (remaining: ReadonlyArray<ReviewFinding>, sentPerRound: ReadonlyArray<ReadonlyArray<ReviewFinding>>, stop: ReviewStop, askUserFindings: ReadonlyArray<ReviewFinding>): ReadonlyArray<LeftFinding> =>
  [...remaining, ...askUserFindings.filter((finding) => !remaining.some((current) => sameFinding(current, finding)))].map((finding) => {
    if (finding.action === "ask-user") return { finding, reason: { kind: "ask-user" } }
    if (stop === "cleared") return { finding, reason: { kind: "stopped", stop } }
    if (stop === "round-limit" && !passesRoundTwoBar(finding)) return { finding, reason: { kind: "round-limit", round: sentPerRound.length } }
    if (!passesRoundTwoBar(finding) && sentPerRound.length > 0) return { finding, reason: { kind: "below-round-2-bar" } }
    const sentIn = sentPerRound.findLastIndex((sent) => sent.some((earlier) => sameFinding(earlier, finding)))
    if (sentIn !== -1) return { finding, reason: { kind: "repeat", round: sentIn + 1 } }
    return { finding, reason: stop === "round-limit" ? { kind: "round-limit", round: sentPerRound.length } : { kind: "stopped", stop } }
  })

export const leftReasonLine = (reason: LeftReason): string =>
  reason.kind === "below-round-2-bar"
    ? "Left because its severity is below the round 2 bar, which fixes only errors."
    : reason.kind === "repeat"
    ? "Left because it has the same topic and file as a finding the fixer received in round " + reason.round.toString() + "."
    : reason.kind === "ask-user"
    ? "Left because it asks the user."
    : reason.kind === "stopped"
    ? "Left because " + reviewStopReason(reason.stop) + "."
    : "Left because the review after fix round " + reason.round.toString() + " reached the round limit."
