import { missingReason, parseRun, type NoMistakesFinding, type OpenQuestion, type ParkedGate, type ParsedRun, type PendingFinding } from "./no-mistakes-gate"
import type { AskedAt } from "./answer-wait"
import { scalar } from "../../shared/lib/index"

type NoMistakesStatus = "passed" | "refused" | "failed"

export interface NoMistakesRecord {
  readonly status: NoMistakesStatus
  readonly gate: string | null
  readonly findings: ReadonlyArray<NoMistakesFinding>
  readonly deferredFindingIds: ReadonlyArray<string>
  readonly gatesAnswered: number
  readonly openQuestions: ReadonlyArray<OpenQuestion>
  readonly prLink: string | null
  readonly reviewer: string | null
  readonly result: string
  readonly started: string
  readonly ended: string
}

export interface Ending {
  readonly status: NoMistakesStatus
  readonly gate: ParkedGate | null
  readonly result: string
  readonly openQuestions: ReadonlyArray<OpenQuestion>
}

interface DeferredGate {
  readonly findingIds: ReadonlyArray<string>
  readonly skippedFixRound: boolean
  readonly unappliedAnswers: ReadonlyArray<string>
}

const deferralNote = (gate: DeferredGate): string => [
  "Findings deferred to PR follow-ups: " + gate.findingIds.join(", ") + ".",
  ...(gate.skippedFixRound ? ["no-mistakes ran no fix round at that gate."] : []),
  ...gate.unappliedAnswers.map((id) => "The captain's answer for " + id + " was not applied.")
].join(" ")

export interface DriveLog {
  readonly read: (output: string) => ParsedRun
  readonly remember: (step: string, findings: ReadonlyArray<NoMistakesFinding>) => void
  readonly noteDeferrals: (gate: DeferredGate) => string
  readonly noteReviewer: (status: string) => void
  readonly runId: () => string
  readonly gatesAnswered: () => number
  readonly countGate: () => void
  readonly gatesSinceCap: () => number
  readonly liftCap: () => void
  readonly refuse: (gate: ParkedGate | null, reason: string) => Ending
  readonly awaitAnswers: (gate: ParkedGate, missing: ReadonlyArray<PendingFinding>, asked: string | null, askedAt: ReadonlyArray<AskedAt>) => Ending
  readonly fail: (reason: string) => Ending
  readonly finish: (parsed: ParsedRun) => Ending
  readonly close: (ending: Ending) => NoMistakesRecord
}

const greenOutcomes = new Set(["checks-passed", "passed"])

const findingKey = (step: string, finding: NoMistakesFinding): string =>
  step + "\n" + (finding.id === "" ? finding.file + "\n" + finding.description : finding.id)

const prNote = (prLink: string | null): string => prLink === null ? "No PR opens." : "The PR " + prLink + " is open but not ready."

const endedReason = (parsed: ParsedRun): string =>
  "no-mistakes ended " + (parsed.outcome === "" ? parsed.status : "with outcome " + parsed.outcome) +
  (parsed.error === "" ? "" : ": " + parsed.error) +
  (parsed.prSkipReason === "" ? "" : ", and it skipped the pr step: " + parsed.prSkipReason)

export const openDriveLog = (started: string): DriveLog => {
  const findings: Array<NoMistakesFinding> = []
  const known = new Set<string>()
  const deferredGates: Array<DeferredGate> = []
  let gatesAnswered = 0
  let capLifted = 0
  let prLink: string | null = null
  let runId = ""
  let reviewer: string | null = null
  const remember = (step: string, seen: ReadonlyArray<NoMistakesFinding>): void => {
    for (const finding of seen) {
      if (!known.has(findingKey(step, finding))) {
        known.add(findingKey(step, finding))
        findings.push(finding)
      }
    }
  }
  const fail = (reason: string): Ending => ({ status: "failed", gate: null, result: reason + ". " + prNote(prLink), openQuestions: [] })
  const refuse = (gate: ParkedGate | null, reason: string): Ending => ({
    status: "refused",
    gate,
    result: "no-mistakes stopped" + (gate === null ? "." : " at the " + gate.step + " gate.") + " " + reason + ". " + prNote(prLink),
    openQuestions: []
  })
  return {
    read: (output) => {
      const parsed = parseRun(output)
      remember(parsed.gate?.step ?? "", parsed.findings)
      prLink = parsed.prLink === "" ? prLink : parsed.prLink
      runId = parsed.runId === "" ? runId : parsed.runId
      return parsed
    },
    remember,
    noteDeferrals: (gate) => {
      deferredGates.push(gate)
      return deferralNote(gate)
    },
    noteReviewer: (status) => {
      const named = scalar(status, "reviewer_agent")
      reviewer = named === "" ? reviewer : named
    },
    runId: () => runId,
    gatesAnswered: () => gatesAnswered,
    countGate: () => {
      gatesAnswered += 1
    },
    gatesSinceCap: () => gatesAnswered - capLifted,
    liftCap: () => {
      capLifted = gatesAnswered
    },
    refuse,
    awaitAnswers: (gate, missing, asked, askedAt) => {
      const at = (finding: NoMistakesFinding): string | null => askedAt.find((entry) => entry.question === finding.id)?.asked ?? asked
      return {
        ...refuse(gate, missingReason(missing)),
        openQuestions: missing.map((finding) => {
          const time = at(finding)
          return { id: finding.id, text: finding.description, ...(finding.asks === undefined ? {} : { asks: finding.asks }), ...(time === null ? {} : { asked: time }), ...(asked === null ? {} : { asking: asked }), ...(finding.owner === undefined ? {} : { owner: finding.owner }) }
        })
      }
    },
    fail,
    finish: (parsed) =>
      greenOutcomes.has(parsed.outcome) && prLink !== null
        ? { status: "passed", gate: null, result: "no-mistakes opened " + prLink + ".", openQuestions: [] }
        : fail(endedReason(parsed)),
    close: (ending) => ({
      status: ending.status,
      gate: ending.gate === null ? null : ending.gate.step,
      findings,
      deferredFindingIds: [...new Set(deferredGates.flatMap((gate) => gate.findingIds))],
      gatesAnswered,
      openQuestions: ending.openQuestions,
      prLink,
      reviewer,
      result: [ending.result, ...deferredGates.map(deferralNote)].join(" "),
      started,
      ended: new Date().toISOString()
    })
  }
}
