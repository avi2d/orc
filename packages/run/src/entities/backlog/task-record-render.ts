import { fence, type Claim, type Hold, type HoldQuestion, type Parked, type ParkedQuestion, type Started, type TaskRecord } from "./task-record"

const field = (key: string, value: unknown): string => key + ": " + JSON.stringify(value)

const claimFields = (claim: Claim | null): ReadonlyArray<string> =>
  claim === null
    ? []
    : [field("beat", claim.beat), field("taken_for", claim.machine), field("account", claim.account), field("taken_at", claim.takenAt)]

const startedFields = (started: Started): ReadonlyArray<string> => [field("started_at", started.at), field("start_log", started.log)]

const questionFronts = (questions: ReadonlyArray<ParkedQuestion>) =>
  questions.map((question) => ({
    id: question.id,
    text: question.text,
    asked_at: question.asked,
    ...(question.answer === null ? {} : { answer: question.answer.words, answered_at: question.answer.at }),
    ...(question.answer?.relayedTo == null ? {} : { relayed_to: question.answer.relayedTo })
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
      ...(hold.history === undefined ? [] : [field("hold_history", hold.history)]),
      ...(hold.until === null ? [] : [field("hold_until", hold.until)]),
      ...(hold.questions.length === 0 ? [] : [field("hold_questions", holdQuestionFronts(hold.questions))]),
      ...(hold.answer === null ? [] : [field("answer", hold.answer.words), field("answered_at", hold.answer.at)])
    ]

const parkedFields = (parked: Parked | null): ReadonlyArray<string> =>
  parked === null
    ? []
    : [field("parked_branch", parked.branch), field("parked_questions", questionFronts(parked.questions)), ...(parked.origin === undefined ? [] : [field("parked_origin", parked.origin)])]

const stateFields = (state: TaskRecord["state"]): ReadonlyArray<string> => {
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
      const ran = state.closing.outcome === "start-failed"
        ? { started: [], pr: [] }
        : {
          started: startedFields(state.closing.started),
          pr: [
            ...(state.closing.pr === null ? [] : [field("pr", state.closing.pr)]),
            ...(state.closing.report === null ? [] : [field("report", state.closing.report)])
          ]
        }
      return [
        ...claimFields(state.claim),
        ...ran.started,
        field("outcome", state.closing.outcome),
        field("closed_at", state.closedAt),
        field("reason", state.closing.reason),
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
    field("created", record.spec.created),
    ...holdFields(record.hold),
    ...parkedFields(record.parked),
    ...stateFields(record.state),
    fence,
    record.spec.body
  ].join("\n")
