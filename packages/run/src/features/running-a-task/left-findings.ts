import type { ReviewFinding } from "./review-outcome"

export const lastFixRound = 2

export const passesRoundTwoBar = (finding: ReviewFinding): boolean => finding.severity === "error"

type LeftReason =
  | { readonly kind: "below-round-2-bar" }
  | { readonly kind: "repeat"; readonly round: number }
  | { readonly kind: "round-limit" }

export interface LeftFinding {
  readonly finding: ReviewFinding
  readonly reason: LeftReason
}

const sameFinding = (one: ReviewFinding, other: ReviewFinding): boolean => one.id === other.id && one.file === other.file

// The caller ran the fix loop to its end, so an error still reported means no fix round was left for it.
export const leftFindings = (remaining: ReadonlyArray<ReviewFinding>, sentPerRound: ReadonlyArray<ReadonlyArray<ReviewFinding>>): ReadonlyArray<LeftFinding> =>
  remaining.map((finding) => {
    if (!passesRoundTwoBar(finding)) {
      return { finding, reason: { kind: "below-round-2-bar" } }
    }
    const sentIn = sentPerRound.findLastIndex((sent) => sent.some((earlier) => sameFinding(earlier, finding)))
    return { finding, reason: sentIn === -1 ? { kind: "round-limit" } : { kind: "repeat", round: sentIn + 1 } }
  })

export const leftReasonLine = (reason: LeftReason): string =>
  reason.kind === "below-round-2-bar"
    ? "Left because its severity is below the round 2 bar, which fixes only errors."
    : reason.kind === "repeat"
    ? "Left because it repeats a finding the fixer received in round " + reason.round.toString() + "."
    : "Left because the round limit was reached: the review after fix round " + lastFixRound.toString() + " reported it."
