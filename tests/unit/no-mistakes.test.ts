import { describe, expect, test } from "bun:test"
import { answerForGate, parseRun } from "../../src/no-mistakes"

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
    expect(parsed.parked).toBe(true)
    expect(parsed.terminal).toBe(false)
    expect(parsed.gate).toBe("review")
    expect(parsed.findings.map((finding) => finding.id)).toEqual(["r1", "r2"])
    expect(parsed.findings.map((finding) => finding.action)).toEqual(["auto-fix", "ask-user"])
    expect(parsed.findings[1]).toMatchObject({ severity: "error", file: "b.go" })
  })

  test("a description quoting action words does not move the action", () => {
    const parsed = parseRun(proseDescription)
    expect(parsed.findings.map((finding) => finding.action)).toEqual(["auto-fix", "auto-fix"])
    expect(answerForGate("review", parsed.findings)).toEqual({ kind: "fix", ids: ["r1", "r2"] })
  })

  test("columns in another order still resolve by name", () => {
    const parsed = parseRun(reorderedColumns)
    expect(parsed.findings.map((finding) => finding.id)).toEqual(["r1", "r2"])
    expect(parsed.findings.map((finding) => finding.action)).toEqual(["auto-fix", "ask-user"])
  })

  test("an unbraced findings block from a resolved round is not the gate table", () => {
    const parsed = parseRun(unbracedPrecursor)
    expect(parsed.findings.map((finding) => finding.id)).toEqual(["r1"])
    expect(answerForGate("review", parsed.findings)).toEqual({ kind: "fix", ids: ["r1"] })
  })

  test("a quoted description holding commas stays one cell", () => {
    const parsed = parseRun(quotedCommaDescription)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]?.description).toBe("the action field is one of auto-fix, ask-user")
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
    expect(parsed.parked).toBe(false)
    expect(parsed.prLink).toBe("https://github.com/o/r/pull/4")
    expect(parsed.outcome).toBe("passed")
    expect(parsed.findings).toEqual([])
  })

  test("a gate block with the step on its own lines names the gate", () => {
    const parsed = parseRun(gateBlock)
    expect(parsed.parked).toBe(true)
    expect(parsed.gate).toBe("review")
  })
})

describe("answerForGate refuses only what needs his word", () => {
  test("a finding marked ask-user names that finding", () => {
    const parsed = parseRun(parked)
    const answer = answerForGate(parsed.gate ?? "unknown", parsed.findings)
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("r2")
      expect(answer.reason).toContain("ask-user")
    }
  })

  test("an open review question names that question", () => {
    const question = parseRun(parked.replace("r2,error,b.go,,ask-user,changes product behavior", "question-3,info,,,ask-user,Which scope should the report cover?"))
    const answer = answerForGate("review", question.findings)
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("question-3")
    }
  })

  test("a gate naming no finding is refused, never approved blind", () => {
    const answer = answerForGate("review", [])
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("review")
    }
  })

  test("an action orc does not know is refused", () => {
    const parsed = parseRun(parked.replace("r2,error,b.go,,ask-user,changes product behavior", "r2,error,b.go,,manual,needs a human"))
    const answer = answerForGate("review", parsed.findings)
    expect(answer.kind).toBe("refuse")
    if (answer.kind === "refuse") {
      expect(answer.reason).toContain("r2")
    }
  })

  test("findings no-mistakes can fix itself are answered with fix", () => {
    const parsed = parseRun(proseDescription)
    expect(answerForGate("review", parsed.findings)).toEqual({ kind: "fix", ids: ["r1", "r2"] })
  })
})
