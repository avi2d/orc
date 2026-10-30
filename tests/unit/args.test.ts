import { describe, expect, test } from "bun:test"
import { parseArgs } from "../../packages/run/src/args"
describe("parseArgs", () => {
  test("no flag is a usage error", () => {
    expect(parseArgs([])).toEqual({ kind: "UsageError", detail: "orc takes one flag" })
  })
  test("--version prints the version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "PrintVersion" })
  })
  test("--help prints the usage text", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "PrintHelp" })
  })
  test("-h prints the usage text", () => {
    expect(parseArgs(["-h"])).toEqual({ kind: "PrintHelp" })
  })
  test("an unknown flag is a usage error", () => {
    expect(parseArgs(["--frobnicate"])).toEqual({ kind: "UsageError", detail: "unknown flag: --frobnicate" })
  })
  test("an extra argument is a usage error", () => {
    expect(parseArgs(["--version", "extra"])).toEqual({ kind: "UsageError", detail: "unexpected argument: extra" })
  })
  test("runs lists recent runs", () => {
    expect(parseArgs(["runs"])).toEqual({ kind: "ListRuns", json: false })
  })
  test("runs --json lists recent runs as JSON", () => {
    expect(parseArgs(["runs", "--json"])).toEqual({ kind: "ListRuns", json: true })
  })
  test("an unknown runs flag is a usage error", () => {
    expect(parseArgs(["runs", "--frobnicate"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --frobnicate" })
  })
  test("an extra runs argument is a usage error", () => {
    expect(parseArgs(["runs", "--json", "extra"])).toEqual({ kind: "UsageError", detail: "unexpected argument: extra" })
  })
  test("show takes a run id", () => {
    expect(parseArgs(["show", "step-run-1"])).toEqual({ kind: "ShowRun", id: "step-run-1", json: false })
  })
  test("show --json takes a run id as JSON", () => {
    expect(parseArgs(["show", "step-run-1", "--json"])).toEqual({ kind: "ShowRun", id: "step-run-1", json: true })
  })
  test("show without a run id is a usage error", () => {
    expect(parseArgs(["show"])).toEqual({ kind: "UsageError", detail: "orc show takes a run id" })
  })
  test("show rejects a flag it does not know", () => {
    expect(parseArgs(["show", "step-run-1", "--frobnicate"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --frobnicate" })
  })
  test("show names the stray token after --json, as runs does", () => {
    expect(parseArgs(["show", "step-run-1", "--json", "extra"])).toEqual({ kind: "UsageError", detail: "unexpected argument: extra" })
  })
    test("score records a score with a note through orc score", () => {
    expect(parseArgs(["score", "show-1", "implement", "5", "clean"])).toEqual({
      kind: "ScoreStep",
      runId: "show-1",
      step: "implement",
      score: 5,
      note: "clean"
    })
  })

  test("score passes an attempt selector through orc score", () => {
    expect(parseArgs(["score", "show-1", "fix#1", "4"])).toEqual({
      kind: "ScoreStep",
      runId: "show-1",
      step: "fix#1",
      score: 4,
      note: ""
    })
  })

  test("score passes a step id through orc score", () => {
    expect(parseArgs(["score", "show-1", "42", "4"])).toEqual({
      kind: "ScoreStep",
      runId: "show-1",
      step: "42",
      score: 4,
      note: ""
    })
  })

  test("score keeps an empty note when orc score omits it", () => {
    expect(parseArgs(["score", "show-1", "implement", "4"])).toEqual({
      kind: "ScoreStep",
      runId: "show-1",
      step: "implement",
      score: 4,
      note: ""
    })
  })

  test("score refuses 0 through orc score", () => {
    expect(parseArgs(["score", "show-1", "implement", "0"])).toEqual({
      kind: "UsageError",
      detail: 'orc score takes a score from 1 to 5, got "0"'
    })
  })

  test("score refuses 6 through orc score", () => {
    expect(parseArgs(["score", "show-1", "implement", "6"])).toEqual({
      kind: "UsageError",
      detail: 'orc score takes a score from 1 to 5, got "6"'
    })
  })

  test("score refuses a non-integer through orc score", () => {
    expect(parseArgs(["score", "show-1", "implement", "2.5"])).toEqual({
      kind: "UsageError",
      detail: 'orc score takes a score from 1 to 5, got "2.5"'
    })
  })

  test("score without enough arguments is a usage error for orc score", () => {
    expect(parseArgs(["score", "show-1", "implement"])).toEqual({
      kind: "UsageError",
      detail: "orc score takes a run id, a step name, a score from 1 to 5 and an optional note"
    })
  })

  test("score names the stray token for orc score", () => {
    expect(parseArgs(["score", "show-1", "implement", "5", "note", "extra"])).toEqual({
      kind: "UsageError",
      detail: "unexpected argument for orc score: extra"
    })
  })

  test("run without a task file is a usage error", () => {
    expect(parseArgs(["run"])).toEqual({ kind: "UsageError", detail: "orc run takes a task file" })
  })
  test("run takes a task file and no branch", () => {
    expect(parseArgs(["run", "task.md"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: undefined, sandbox: undefined, tokenFile: undefined, provider: undefined, allow: [], answers: [] })
  })
  test("run takes a task file and a branch", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", sandbox: undefined, tokenFile: undefined, provider: undefined, allow: [], answers: [] })
  })
  test("run takes the branch before the task file", () => {
    expect(parseArgs(["run", "--branch", "orc/demo", "task.md"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", sandbox: undefined, tokenFile: undefined, provider: undefined, allow: [], answers: [] })
  })
  test("run takes a branch alone to resume it", () => {
    expect(parseArgs(["run", "--branch", "orc/demo"])).toEqual({ kind: "RunAgent", taskFile: null, branch: "orc/demo", sandbox: undefined, tokenFile: undefined, provider: undefined, allow: [], answers: [] })
  })
  test("run without a task file or a branch to resume is a usage error", () => {
    expect(parseArgs(["run", "--allow", "ask-user"])).toEqual({ kind: "UsageError", detail: "orc run takes a task file" })
  })
  test("run rejects a second task file", () => {
    expect(parseArgs(["run", "task.md", "other.md"])).toEqual({ kind: "UsageError", detail: "unexpected argument: other.md" })
  })
  test("run rejects a second branch", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/a", "--branch", "orc/b"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --branch" })
  })
  test("run takes a branch and the word after a refusal", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--allow", "ask-user"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", sandbox: undefined, tokenFile: undefined, provider: undefined, allow: ["ask-user"], answers: [] })
  })
  test("run takes the captain answer after a refusal", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--answer", "question-3=Use the wide scope"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", sandbox: undefined, tokenFile: undefined, provider: undefined, allow: [], answers: [{ question: "question-3", answer: "Use the wide scope" }] })
  })
  test("run takes the word and the answer after refusals", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--allow", "ask-user", "--answer", "question-3=Use the wide scope"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", sandbox: undefined, tokenFile: undefined, provider: undefined, allow: ["ask-user"], answers: [{ question: "question-3", answer: "Use the wide scope" }] })
  })
  test("run rejects the question word for the allow flag", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--allow", "question"])).toEqual({ kind: "UsageError", detail: "unknown word for --allow: question" })
  })
  test("run rejects the wordless flag after a refusal", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--allow"])).toEqual({ kind: "UsageError", detail: "orc run takes a word after --allow" })
  })
  test("run rejects an unknown word for the flag", () => {
    expect(parseArgs(["run", "task.md", "--allow", "push"])).toEqual({ kind: "UsageError", detail: "unknown word for --allow: push" })
  })
  test("run rejects the answerless flag after a refusal", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--answer"])).toEqual({ kind: "UsageError", detail: "orc run takes an answer after --answer" })
  })
  test("run rejects an answer without question-id=text", () => {
    expect(parseArgs(["run", "task.md", "--answer", "wide scope"])).toEqual({ kind: "UsageError", detail: "orc run takes question-id=text after --answer" })
  })
  test("run rejects an unknown question for the answer flag", () => {
    expect(parseArgs(["run", "task.md", "--answer", "finding-1=no"])).toEqual({ kind: "UsageError", detail: "unknown question for --answer: finding-1" })
  })
  test("run rejects a repeated answer for one question", () => {
    expect(parseArgs(["run", "task.md", "--answer", "question-3=a", "--answer", "question-3=b"])).toEqual({ kind: "UsageError", detail: "duplicate answer for --answer: question-3" })
  })
  test("run rejects a flag it does not know", () => {
    expect(parseArgs(["run", "task.md", "--json"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --json" })
  })
  test("run rejects a branch flag without a name", () => {
    expect(parseArgs(["run", "task.md", "--branch"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --branch" })
  })
})
describe("parseArgs run flags", () => {
  test("run takes --sandbox none instead of the nono default", () => {
    expect(parseArgs(["run", "task.md", "--sandbox", "none"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: undefined, sandbox: "none", tokenFile: undefined, provider: undefined, allow: [], answers: [] })
  })
  test("run takes --sandbox nono by name, not only as the default", () => {
    expect(parseArgs(["run", "--sandbox", "nono", "--branch", "orc/demo"])).toEqual({ kind: "RunAgent", taskFile: null, branch: "orc/demo", sandbox: "nono", tokenFile: undefined, provider: undefined, allow: [], answers: [] })
  })
  test("run rejects a sandbox kind it does not know instead of falling back to nono", () => {
    expect(parseArgs(["run", "task.md", "--sandbox", "docker"])).toEqual({ kind: "UsageError", detail: "orc run takes --sandbox once, with nono or none" })
  })
  test("run rejects a sandbox flag without a kind instead of reading the task file as one", () => {
    expect(parseArgs(["run", "task.md", "--sandbox"])).toEqual({ kind: "UsageError", detail: "orc run takes --sandbox once, with nono or none" })
  })
  test("run rejects a second sandbox flag instead of keeping the last", () => {
    expect(parseArgs(["run", "task.md", "--sandbox", "none", "--sandbox", "nono"])).toEqual({ kind: "UsageError", detail: "orc run takes --sandbox once, with nono or none" })
  })
  test("run keeps the --token-file path apart from the task file instead of reading it as one", () => {
    expect(parseArgs(["run", "task.md", "--sandbox", "none", "--token-file", "/secrets/main"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: undefined, sandbox: "none", tokenFile: "/secrets/main", provider: undefined, allow: [], answers: [] })
  })
  test("run keeps the --provider id apart from the task file instead of reading it as one", () => {
    expect(parseArgs(["run", "--provider", "keyed", "task.md", "--token-file", "/secrets/main"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: undefined, sandbox: undefined, tokenFile: "/secrets/main", provider: "keyed", allow: [], answers: [] })
  })
  test("run rejects a provider flag without an id instead of taking the next flag as one", () => {
    expect(parseArgs(["run", "task.md", "--provider", "--sandbox", "none"])).toEqual({ kind: "UsageError", detail: "orc run takes --provider once, with a provider id" })
  })
  test("run rejects a second provider flag instead of keeping the last", () => {
    expect(parseArgs(["run", "task.md", "--provider", "a", "--provider", "b"])).toEqual({ kind: "UsageError", detail: "orc run takes --provider once, with a provider id" })
  })
  test("run rejects a token-file flag without a path instead of taking the next flag as one", () => {
    expect(parseArgs(["run", "task.md", "--token-file", "--sandbox", "none"])).toEqual({ kind: "UsageError", detail: "orc run takes --token-file once, with a path" })
  })
  test("run rejects a second token-file flag instead of keeping the last", () => {
    expect(parseArgs(["run", "task.md", "--token-file", "/a", "--token-file", "/b"])).toEqual({ kind: "UsageError", detail: "orc run takes --token-file once, with a path" })
  })
})
