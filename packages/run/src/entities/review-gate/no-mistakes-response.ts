import { Effect } from "effect"
import { scalar, splitRow } from "../../shared/lib/index"
import { appendGate, type DriveLog } from "./no-mistakes-drive-log"

export interface NoMistakesReply {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface RecordedResponse {
  readonly followUps: ReadonlyArray<string>
  readonly sentToFixer: ReadonlyArray<string> | null
}

const recordedBlock = (output: string): ReadonlyArray<string> => {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trimEnd() === "recorded:")
  if (start === -1) {
    return []
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !line.startsWith(" "))
  return end === -1 ? rest : rest.slice(0, end)
}

const recordedIds = (block: ReadonlyArray<string>, key: string): ReadonlyArray<string> | null => {
  const header = new RegExp("^  " + key + "\\[(\\d+)\\]: *(.*)$")
  for (const line of block) {
    const match = header.exec(line)
    if (match !== null) {
      const ids = match[2] === "" ? [] : splitRow(match[2])
      return ids.length === Number(match[1]) && ids.every((id) => id !== "") ? ids : null
    }
  }
  return null
}

const recordedResponse = (output: string): RecordedResponse => {
  const block = recordedBlock(output)
  return {
    followUps: recordedIds(block, "follow_ups") ?? [],
    sentToFixer: recordedIds(block, "sent_to_fixer") ?? recordedIds(block, "fixed")
  }
}

export const settleFixResponse = Effect.fnUntraced(function*(
  runDir: string,
  log: DriveLog,
  supplied: Map<string, string>,
  answeredIds: ReadonlyArray<string>,
  reply: NoMistakesReply
) {
  const { followUps, sentToFixer } = recordedResponse(reply.stdout)
  if (followUps.length > 0) {
    const note = log.noteDeferrals({
      findingIds: followUps,
      skippedFixRound: sentToFixer?.length === 0,
      unappliedAnswers: followUps.filter((id) => supplied.has(id))
    })
    yield* appendGate(runDir, note)
  }
  const legacyAccepted = reply.exitCode === 0 && scalar(reply.stdout, "error") === ""
  for (const id of answeredIds) {
    if (!followUps.includes(id) && (sentToFixer?.includes(id) ?? legacyAccepted)) {
      supplied.delete(id)
    }
  }
})
