import { ScrollHandle } from "gpui-base"
import { readTextFile } from "herdr"
import { opensTurns } from "./run-agent"
import type { Keyed } from "./agents-view"
import { type ChecksSummary, checkIndexFile, checksSummary, logLines, parseCheckIndex } from "./checks"
import type { ShownStep } from "./guard"
import { type Reading, readText } from "./orc-read"
import type { Pane } from "./step-bar"
import { type Turn, sessionTurns } from "./turns"

export class StepOutput {
  log: Keyed<string> | null = null
  summary: Keyed<ChecksSummary> | null = null
  turns: Keyed<ReadonlyArray<Turn>> | null = null
  readonly logScroll = ScrollHandle.new()
  readonly turnsScroll = ScrollHandle.new()
  readonly checksScroll = ScrollHandle.new()
  private shownLines = 0
  private turnsText: string | null = null

  read(of: string, runId: string, step: ShownStep, pane: Pane, taskFile: string): Promise<void> {
    if (pane === "parsed") {
      if (step.name === "checks") return this.readSummary(of, runId, step, taskFile)
      if (opensTurns(step)) return this.readTurns(of, step.piSessionFile)
    }
    return this.readLog(of, runId, step.id).then(() => undefined)
  }

  private readSummary(of: string, runId: string, step: ShownStep, taskFile: string): Promise<void> {
    const file = checkIndexFile(taskFile, step)
    const index = readTextFile(file).then(
      (text) => text === null ? null : parseCheckIndex(text),
      () => ({ kind: "refused", reason: `Cannot read ${file}` }) as const
    )
    return index.then((bounds) => this.readLog(of, runId, step.id).then((log) => {
      const reading: Reading<ChecksSummary> = log.kind !== "ok" ? log
        : bounds?.kind === "refused" ? { kind: "failed", reason: bounds.reason }
        : { kind: "ok", value: checksSummary(log.value, step.status, bounds?.value ?? null) }
      if (this.summary?.of !== of) this.checksScroll.scroll_to_item(0)
      this.summary = { of, reading }
    }))
  }

  private readLog(of: string, runId: string, stepId: number): Promise<Reading<string>> {
    return readText("orc", ["log", runId, stepId.toString()]).then((reading) => {
      const lines = reading.kind === "ok" ? logLines(reading.value).length : 0
      if (this.log?.of !== of || lines !== this.shownLines) {
        this.shownLines = lines
        this.logScroll.scroll_to_item(Math.max(lines - 1, 0))
      }
      this.log = { of, reading }
      return reading
    })
  }

  private readTurns(of: string, file: string | null): Promise<void> {
    if (file === null) {
      this.showTurns(of, "", "")
      return Promise.resolve()
    }
    return readTextFile(file).then(
      (text) => this.showTurns(of, file, text ?? ""),
      () => {
        this.turnsText = null
        this.turns = { of, reading: { kind: "failed", reason: `Cannot read ${file}` } }
      }
    )
  }

  private showTurns(of: string, file: string, text: string): void {
    if (this.turns?.of === of && text === this.turnsText) {
      return
    }
    const before = this.turns?.of === of && this.turns.reading.kind === "ok" ? this.turns.reading.value.length : 0
    const parsed = sessionTurns(text)
    this.turnsText = text
    this.turns = { of, reading: parsed.kind === "ok" ? { kind: "ok", value: parsed.value } : { kind: "failed", reason: `${file}: ${parsed.reason}` } }
    if (parsed.kind === "ok" && parsed.value.length > before) {
      this.turnsScroll.scroll_to_item(parsed.value.length - 1)
    }
  }
}
