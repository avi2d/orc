import { decisionAnswer, fence, type Claim, type Hold, type HoldQuestion, isDeciderAnswer, type Parked, type ParkedAnswer, type ParkedQuestion, ranClosing, type Started, type TaskRecord } from "./task-record"
import { choicesOf } from "./task-record-question"

const field = (key: string, value: unknown): string => key + ": " + JSON.stringify(value)

const claimFields = (claim: Claim | null): ReadonlyArray<string> =>
  claim === null
    ? []
    : [field("beat", claim.beat), field("taken_for", claim.machine), field("account", claim.account), field("taken_at", claim.takenAt)]

const startedFields = (started: Started): ReadonlyArray<string> => [field("started_at", started.at), field("start_log", started.log)]

const answerFronts = (answer: ParkedAnswer) => {
  if (isDeciderAnswer(answer)) {
    return { answered_by: answer.by }
  }
  const overturned = answer.overturned
  return overturned === undefined
    ? {}
    : { overturned: { answer: overturned.words, answered_at: overturned.at, answered_by: overturned.by, ...(overturned.relayedTo === null ? {} : { relayed_to: overturned.relayedTo }) } }
}

const questionFronts = (questions: ReadonlyArray<ParkedQuestion>) =>
  questions.map((question) => ({
    id: question.id,
    text: question.text,
    asked_at: question.asked,
    ...(question.blocks ? {} : { blocks: false }),
    ...choicesOf(question),
    ...(question.answer === null ? {} : { answer: question.answer.words, answered_at: question.answer.at, ...answerFronts(question.answer) }),
    ...(question.answer?.relayedTo == null ? {} : { relayed_to: question.answer.relayedTo }),
    ...(question.answer !== null && !isDeciderAnswer(question.answer) && question.answer.correctionQueued === true ? { correction_queued: true } : {})
  }))

const holdQuestionFronts = (questions: ReadonlyArray<HoldQuestion>) =>
  questions.map((question) => ({
    id: question.id,
    text: question.text,
    ...(question.answer === null ? {} : { answer: question.answer.words, answered_at: question.answer.at })
  }))

const holdFields = (hold: Hold | null): ReadonlyArray<string> =>
  hold === null
    ? []
    : [
      field("hold_reason", hold.reason),
      ...(hold.repeat === true ? [field("hold_repeat", true)] : []),
      ...(hold.history === undefined ? [] : [field("hold_history", hold.history)]),
      ...(hold.until === null ? [] : [field("hold_until", hold.until)]),
      ...(hold.at === null ? [] : [field("held_at", hold.at)]),
      ...(hold.questions.length === 0 ? [] : [field("hold_questions", holdQuestionFronts(hold.questions))]),
      ...(hold.answer === null ? [] : [field("answer", hold.answer.words), field("answered_at", hold.answer.at)])
    ]

const parkedFields = (parked: Parked | null): ReadonlyArray<string> =>
  parked === null
    ? []
    : [field("parked_branch", parked.branch), field("parked_questions", questionFronts(parked.questions)), ...(parked.origin === undefined ? [] : [field("parked_origin", parked.origin)])]

const ranFields = (record: TaskRecord): { readonly started: ReadonlyArray<string>; readonly pr: ReadonlyArray<string> } => {
  const ran = ranClosing(record)
  return ran === null
    ? { started: [], pr: [] }
    : {
      started: startedFields(ran.started),
      pr: [...(ran.pr === null ? [] : [field("pr", ran.pr)]), ...(ran.report === null ? [] : [field("report", ran.report)])]
    }
}

const stateFields = (record: TaskRecord): ReadonlyArray<string> => {
  const state = record.state
  switch (state.kind) {
    case "new": {
      return []
    }
    case "taken": {
      return claimFields(state.claim)
    }
    case "started": {
      return [...claimFields(state.claim), ...startedFields(state.started)]
    }
    case "closed": {
      const ran = ranFields(record)
      const answer = decisionAnswer(record)
      return [
        ...claimFields(state.claim),
        ...ran.started,
        field("outcome", state.closing.outcome),
        field("closed_at", state.closedAt),
        field("reason", state.closing.reason),
        ...(answer === null ? [] : [field("answer", answer.words), field("answered_at", answer.at)]),
        ...ran.pr,
        ...(state.postedAt === null ? [] : [field("posted_at", state.postedAt)])
      ]
    }
  }
}

export const renderTaskFile = (record: TaskRecord): string =>
  [
    fence,
    field("id", record.spec.id),
    field("title", record.spec.title),
    field("project", record.spec.project),
    field("kind", record.spec.kind),
    ...(record.spec.internal ? [field("internal", true)] : []),
    field("machine", record.spec.machine),
    ...(record.spec.parent === null ? [] : [field("parent", record.spec.parent)]),
    ...(record.spec.split === null ? [] : [field("split", record.spec.split)]),
    field("depends_on", record.spec.dependsOn),
    ...(record.spec.priority === null ? [] : [field("priority", record.spec.priority)]),
    field("created", record.spec.created),
    ...holdFields(record.hold),
    ...parkedFields(record.parked),
    ...stateFields(record),
    fence,
    record.spec.body
  ].join("\n")
