import { type AsyncContext } from "gpui-kit"
import { exec, nextCommand, notify } from "herdr"
import { type MergeOutcome } from "./agents-view"

export interface Merge {
  readonly task: string
  readonly outcome: MergeOutcome
}

export const mergeCommand = "merge:"

const mergeTimeoutMs = 25 * 60 * 1000

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

export const runMerge = (task: string): Promise<string | null> =>
  exec("orc", ["merge", task, "--basis", "captain-word"], { timeout: mergeTimeoutMs }).then(
    (result) => result.code === 0 ? null : `orc merge ${task} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
    (reason: unknown) => {
      const said = reason instanceof Error ? reason.message : String(reason)
      return /timed? ?out/i.test(said) ? `orc merge ${task} timed out waiting for checks.` : `orc merge ${task} did not finish: ${said}.`
    }
  )

export const mergedNote = (task: string): void => {
  notify({ title: `Merged ${task}`, level: "success" })
}

export const watchMerges = (cx: AsyncContext, start: (cx: AsyncContext, task: string) => void): Promise<void> =>
  nextCommand().then((command) => {
    if (command.startsWith(mergeCommand)) {
      start(cx, command.slice(mergeCommand.length))
    }
    return watchMerges(cx, start)
  }, () => undefined)
