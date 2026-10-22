import { describe, expect, test } from "bun:test"
import { parseArgs } from "../../src/args"
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
  test("run without a task file is a usage error", () => {
    expect(parseArgs(["run"])).toEqual({ kind: "UsageError", detail: "orc run takes a task file" })
  })
  test("run takes a task file and no branch", () => {
    expect(parseArgs(["run", "task.md"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: undefined, allow: [], answers: [] })
  })
  test("run takes a task file and a branch", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", allow: [], answers: [] })
  })
  test("run takes a branch and the word after a refusal", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--allow", "ask-user"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", allow: ["ask-user"], answers: [] })
  })
  test("run takes the captain answer after a refusal", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--answer", "question-3=Use the wide scope"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", allow: [], answers: [{ question: "question-3", answer: "Use the wide scope" }] })
  })
  test("run takes the word and the answer after refusals", () => {
    expect(parseArgs(["run", "task.md", "--branch", "orc/demo", "--allow", "ask-user", "--answer", "question-3=Use the wide scope"])).toEqual({ kind: "RunAgent", taskFile: "task.md", branch: "orc/demo", allow: ["ask-user"], answers: [{ question: "question-3", answer: "Use the wide scope" }] })
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
