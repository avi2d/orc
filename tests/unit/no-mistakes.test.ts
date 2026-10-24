import { describe, expect, test } from "bun:test"
import { answerArgsFor, answerForGate, noMistakesBinary, omittedQuestionIds, parseRun, type NoMistakesFinding } from "../../src/no-mistakes"
import { formatReport, type OrcRunReport } from "../../src/run-record"

const approvalGate = { step: "review", stage: "approval" } as const
const fixReview = { step: "review", stage: "fix-review" } as const

const stubFinding = (id: string, action: string): NoMistakesFinding => ({ id, severity: "warning", file: "a.go", line: "", action, description: "a finding" })

const parked = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: awaiting_approval",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[2]{id,severity,file,line,action,description}:",
  "    r1,warning,a.go,,auto-fix,ignored error",
  "    r2,error,b.go,,ask-user,changes product behavior",
  "gate: review"
].join("\n")

const proseDescription = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: fix_review",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[2]{id,severity,file,line,action,description}:",
  "    r1,warning,a.go,,auto-fix,the action field is one of no-op, auto-fix, ask-user, so pick one",
  "    r2,warning,b.go,,auto-fix,ignored error",
  "gate: review"
].join("\n")

const reorderedColumns = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: awaiting_approval",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[2]{severity,action,id,file,line,description}:",
  "    warning,auto-fix,r1,a.go,,ignored error",
  "    error,ask-user,r2,b.go,,changes product behavior",
  "gate: review"
].join("\n")

const unbracedPrecursor = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: fix_review",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[2]:",
  "    prior-1,warning,a.go,ask-user,an earlier already-resolved row",
  "    prior-2,info,b.go,ask-user,another earlier row",
  "  findings[1]{id,severity,file,action,description}:",
  "    r1,warning,a.go,auto-fix,the live gate is owed to the crewmate",
  "gate: review"
].join("\n")

const quotedCommaDescription = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: fix_review",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[1]{id,severity,file,line,description,action}:",
  "    r1,warning,a.go,12,\"the action field is one of auto-fix, ask-user\",auto-fix",
  "gate: review"
].join("\n")

const escapedDescription = [
  "run:",
  "  id: \"01RUN\"",
  "  status: running",
  "  pr: \"\"",
  "  findings[1]{id,severity,file,line,description,action}:",
  "    r1,warning,a.go,12,\"Use \\\"left,right\\\" consistently\\nin both panes\",auto-fix",
  "gate: review"
].join("\n")

const reviewLogRow = [
  "step: review",
  "run: \"01RUN\"",
  "findings[1]{id,severity,file,action,carried,description}:",
  "  R6,warning,agents/fixer.md,ask-user,\"not selected earlier, not re-reported\",\"Simplification: remove the fixer until that phase is requested.\"",
].join("\n")

const completedRun = [
  "current_branch: orc/test",
  "other_branch_run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: completed",
  "  head: abc1234",
  "  pr: \"https://github.com/o/r/pull/4\"",
  "  findings: 1 awaiting",
  "  steps[2]{step,status,findings,duration_ms}:",
  "    intent,completed,0,89",
  "    review,completed,1,3928433",
  "outcome: passed"
].join("\n")

const gateBlock = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: running",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[1]{id,severity,file,line,action,description}:",
  "    r1,error,b.go,,ask-user,changes product behavior",
  "gate:",
  "  step: review",
  "  status: fix_review",
  "steps[3]{step,status,findings,duration_ms}:",
  "  intent,completed,0,0",
  "  review,fix_review,1,0",
  "  test,pending,0,0"
].join("\n")

describe("parseRun reads the recorded TOON shapes", () => {
  test("a parked gate keeps its step, its findings and their actions", () => {
    const parsed = parseRun(parked)
    expect(parsed.terminal).toBe(false)
    expect(parsed.gate).toEqual({ step: "review", stage: "approval" })
    expect(parsed.findings.map((finding) => finding.id)).toEqual(["r1", "r2"])
    expect(parsed.findings.map((finding) => finding.action)).toEqual(["auto-fix", "ask-user"])
    expect(parsed.findings[1]).toMatchObject({ severity: "error", file: "b.go" })
  })

  test("a description quoting action words does not move the action", () => {
    const parsed = parseRun(proseDescription)
    expect(parsed.findings.map((finding) => finding.action)).toEqual(["auto-fix", "auto-fix"])
  })

  test("a run parked in fix review names that stage", () => {
    expect(parseRun(proseDescription).gate).toEqual({ step: "review", stage: "fix-review" })
  })

  test("columns in another order still resolve by name", () => {
    const parsed = parseRun(reorderedColumns)
    expect(parsed.findings.map((finding) => finding.id)).toEqual(["r1", "r2"])
    expect(parsed.findings.map((finding) => finding.action)).toEqual(["auto-fix", "ask-user"])
  })

  test("an unbraced findings block from a resolved round is not the gate table", () => {
    const parsed = parseRun(unbracedPrecursor)
    expect(parsed.findings.map((finding) => finding.id)).toEqual(["r1"])
  })

  test("a quoted description holding commas stays one cell", () => {
    const parsed = parseRun(quotedCommaDescription)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]?.description).toBe("the action field is one of auto-fix, ask-user")
    expect(parsed.findings[0]?.action).toBe("auto-fix")
  })

  test("escaped quotes and newlines in a quoted cell decode and do not split it", () => {
    const parsed = parseRun(escapedDescription)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]?.description).toBe("Use \"left,right\" consistently\nin both panes")
    expect(parsed.findings[0]?.action).toBe("auto-fix")
  })

  test("a recorded review log row carries its columns past the action", () => {
    const parsed = parseRun(reviewLogRow)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]).toMatchObject({ id: "R6", severity: "warning", file: "agents/fixer.md", action: "ask-user" })
  })

  test("a completed run carries the PR link and the outcome", () => {
    const parsed = parseRun(completedRun)
    expect(parsed.terminal).toBe(true)
    expect(parsed.gate).toBeNull()
    expect(parsed.prLink).toBe("https://github.com/o/r/pull/4")
    expect(parsed.outcome).toBe("passed")
    expect(parsed.findings).toEqual([])
  })

  test("a gate block with the step on its own lines names the gate", () => {
    const parsed = parseRun(gateBlock)
    expect(parsed.gate).toEqual({ step: "review", stage: "fix-review" })
  })

  test("checks-passed is the outcome even while the run status stays active", () => {
    const parsed = parseRun(["run:", "  status: running", "  pr: \"https://github.com/o/r/pull/4\"", "outcome: checks-passed"].join("\n"))
    expect(parsed.terminal).toBe(true)
    expect(parsed.outcome).toBe("checks-passed")
  })
})

describe("omitted review questions", () => {
  test("ids from the omission notice are omitted ids", () => {
    const output = parked.replace("gate: review", "review-questions-omitted: 2 further review question(s) are open and have no row of their own. This gate releases only once EVERY open question is answered, so answer these by id as well, with: no-mistakes axi answer --question <id> --answer \"<your answer>\". Omitted question ids: question-5, question-6\ngate: review")
    expect(omittedQuestionIds(output)).toEqual(["question-5", "question-6"])
  })
})
describe("answerForGate refuses only what needs your word", () => {
  test("a finding marked ask-user names that finding", () => {
    const parsed = parseRun(parked)
    const answer = answerForGate(approvalGate, parsed.findings)
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("r2")
      expect(answer.reason).toContain("ask-user")
      expect(answer.reason).toContain("needs your word")
      expect(answer.reason).toContain("--allow ask-user")
    }
  })

  test("an open review question names the question and its answer rerun", () => {
    const question = parseRun(parked.replace("r2,error,b.go,,ask-user,changes product behavior", "question-3,info,,,ask-user,Which scope should the report cover?"))
    const answer = answerForGate(approvalGate, question.findings)
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("question-3")
      expect(answer.reason).toContain("Which scope should the report cover?")
      expect(answer.reason).toContain("--answer question-3=")
    }
  })

  test("the ask-user word answers the ask-user gate", () => {
    const parsed = parseRun(parked)
    expect(answerForGate(approvalGate, parsed.findings, ["ask-user"])).toEqual({ kind: "fix", ids: ["r1"], ignore: ["r2"] })
  })

  test("an open review question stays refused past the allow word and fix review", () => {
    const question = parseRun(parked.replace("r2,error,b.go,,ask-user,changes product behavior", "question-3,info,,,ask-user,Which scope should the report cover?"))
    expect(answerForGate(approvalGate, question.findings, ["ask-user"]).kind).toBe("refuse")
    expect(answerForGate(fixReview, question.findings, ["ask-user"]).kind).toBe("refuse")
    const both = answerForGate(approvalGate, [{ ...stubFinding("question-3", "ask-user"), description: "Which scope should the report cover?" }, { ...stubFinding("question-4", "ask-user"), description: "Which retries are allowed?" }])
    expect(both.kind).toBe("refuse")
    if (both.kind === "refuse") {
      expect(both.reason).toContain("question-3")
      expect(both.reason).toContain("question-4")
      expect(both.reason).toContain("--answer question-3=")
      expect(both.reason).toContain("--answer question-4=")
    }
    expect(answerArgsFor("question-3", "Use the wide scope")).toEqual(["axi", "answer", "--question", "question-3", "--answer", "Use the wide scope"])
  })

  test("a gate naming no finding is refused, never approved blind", () => {
    const answer = answerForGate(approvalGate, [])
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("review")
    }
  })

  test("an action orc does not know is refused", () => {
    const parsed = parseRun(parked.replace("r2,error,b.go,,ask-user,changes product behavior", "r2,error,b.go,,manual,needs a human"))
    const answer = answerForGate(approvalGate, parsed.findings)
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("r2")
    }
  })

  test("a finding with no action is refused rather than fixed", () => {
    const answer = answerForGate(approvalGate, [stubFinding("r1", "auto-fix"), stubFinding("r2", "")])
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("r2")
    }
  })

  test("findings no-mistakes can fix itself are answered with fix", () => {
    expect(answerForGate(approvalGate, [stubFinding("r1", "auto-fix"), stubFinding("r2", "auto-fix")])).toEqual({ kind: "fix", ids: ["r1", "r2"], ignore: [] })
  })

  test("a no-op finding beside a fixable one is declined, since fix must name every finding", () => {
    expect(answerForGate(approvalGate, [stubFinding("r1", "auto-fix"), stubFinding("r2", "no-op")])).toEqual({ kind: "fix", ids: ["r1"], ignore: ["r2"] })
  })

  test("a gate holding only no-op findings is approved", () => {
    expect(answerForGate(approvalGate, [stubFinding("r1", "no-op")])).toEqual({ kind: "approve" })
  })

  test("a fix review of safe findings is accepted, not fixed again", () => {
    expect(answerForGate(fixReview, [stubFinding("r1", "auto-fix")])).toEqual({ kind: "approve" })
  })

  test("a fix review still holding an ask-user finding is refused", () => {
    expect(answerForGate(fixReview, [stubFinding("r1", "auto-fix"), stubFinding("r2", "ask-user")]).kind).toBe("refuse")
  })
})

const report = (overrides: Partial<OrcRunReport>): OrcRunReport => ({
  runId: "run-1",
  runDir: "/runs/run-1",
  branch: "orc/test",
  agentPath: "bundled/implementer.md",
  agentSource: "bundled",
  model: "opencode-go/muse-spark",
  sessionId: null,
  sessionFile: null,
  commits: [{ sha: "abc1234", subject: "work" }],
  tokens: null,
  completed: false,
  markerVerified: true,
  implementPassed: true,
  checksRounds: null,
  fixes: [],
  fixAttempts: 0,
  prLink: null,
  noMistakes: null,
  endReason: "",
  ...overrides
})

const round = (number: number, passed: boolean) => ({ round: number, file: "checks-" + number.toString() + ".txt", started: "", ended: "", passed, failed: passed ? [] : ["lint"], checks: [] })

const statusLine = (text: string): string | undefined => text.split("\n").find((line) => line.startsWith("status: "))

describe("formatReport names the phase the run stopped in", () => {
  test("checks fixed on a later round and a refused gate after the PR opened read as no-mistakes with a PR", () => {
    const text = formatReport(report({
      checksRounds: [round(1, false), round(2, true)],
      fixAttempts: 1,
      prLink: "https://github.com/o/r/pull/4",
      noMistakes: { status: "refused", gate: "ci", findings: [], gatesAnswered: 0, prLink: "https://github.com/o/r/pull/4", result: "", started: "", ended: "" }
    }))
    expect(statusLine(text)).toBe("status: no-mistakes refused, PR open")
  })

  test("a final failing checks round reads as checks failed", () => {
    expect(statusLine(formatReport(report({ checksRounds: [round(1, true), round(2, false)] })))).toBe("status: checks failed")
  })
})

describe("noMistakesBinary", () => {
  test("ORC_NO_MISTAKES_BIN names the binary, and unset or blank leaves no-mistakes on the PATH", () => {
    expect(noMistakesBinary("/opt/nm/bin/no-mistakes")).toBe("/opt/nm/bin/no-mistakes")
    expect(noMistakesBinary(undefined)).toBe("no-mistakes")
    expect(noMistakesBinary("  ")).toBe("no-mistakes")
  })
})
