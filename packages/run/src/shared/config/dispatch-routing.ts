import { Effect, Schema } from "effect"
import { ConfigError } from "./json-file"
import { runKinds, TaskId, type RunKind } from "../lib/index"
import { ModelRef } from "./orc-config"
import { providerOfModel } from "./model-route"

const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))
const EstimatedLines = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const RoutedModels = Schema.Struct({
  implementer: ModelRef,
  fixer: Schema.optionalKey(ModelRef),
  reviewer: Schema.optionalKey(ModelRef)
}).check(Schema.makeFilter(({ implementer, fixer, reviewer }) =>
  [fixer, reviewer].every((model) => model === undefined || providerOfModel(model) === providerOfModel(implementer))
    ? undefined
    : "the implementer, fixer, and reviewer must use one provider"
))
export type RoutedModels = typeof RoutedModels.Type
export const RoutedModelsJson = Schema.fromJsonString(RoutedModels)

const Candidate = Schema.Union([ModelRef, Schema.Struct({ models: RoutedModels, account: Schema.optionalKey(Name) })])
const Candidates = Schema.NonEmptyArray(Candidate)

const Match = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(runKinds)),
  project: Schema.optionalKey(Name),
  category: Schema.optionalKey(Name),
  minEstimatedLines: Schema.optionalKey(EstimatedLines)
})

const TaskRouting = Schema.Struct({
  model: Schema.optionalKey(Candidate),
  category: Schema.optionalKey(Name),
  estimatedLines: Schema.optionalKey(EstimatedLines)
})

export const DispatchRouting = Schema.Struct({
  rules: Schema.Array(Schema.Struct({ when: Match, candidates: Candidates })),
  default: Candidates,
  tasks: Schema.optionalKey(Schema.Record(TaskId, TaskRouting))
})
export type DispatchRouting = typeof DispatchRouting.Type

interface RouteTask {
  readonly id: string
  readonly project: string
  readonly kind: RunKind
}

const matches = (when: typeof Match.Type, task: RouteTask, settings: typeof TaskRouting.Type | undefined): boolean =>
  (when.kind === undefined || when.kind === task.kind)
  && (when.project === undefined || when.project === task.project)
  && (when.category === undefined || when.category === settings?.category)
  && (when.minEstimatedLines === undefined || (settings?.estimatedLines !== undefined && settings.estimatedLines >= when.minEstimatedLines))

export const roomAtFloor = (remainingPercent: number, floorPercent: number): boolean =>
  remainingPercent > 0 && remainingPercent >= floorPercent

interface AccountRoom {
  readonly name: string
  readonly provider: string
  readonly remainingPercent: number
}

type RouteResult =
  | { readonly kind: "routed"; readonly account: string; readonly models: RoutedModels }
  | { readonly kind: "waits"; readonly reason: string }

export const resolveDispatch = (
  routing: DispatchRouting,
  task: RouteTask,
  quota: { readonly floorPercent: number; readonly accounts: ReadonlyArray<AccountRoom> }
): RouteResult => {
  const settings = routing.tasks?.[task.id]
  const pin = settings?.model
  const candidates = pin === undefined
    ? routing.rules.find(({ when }) => matches(when, task, settings))?.candidates ?? routing.default
    : [pin]
  for (const candidate of candidates) {
    const route = typeof candidate === "string" ? { models: { implementer: candidate }, account: undefined } : candidate
    const provider = providerOfModel(route.models.implementer)
    const account = quota.accounts
      .filter((entry) => entry.provider === provider && (route.account === undefined || entry.name === route.account)
        && roomAtFloor(entry.remainingPercent, quota.floorPercent))
      .toSorted((left, right) => right.remainingPercent - left.remainingPercent)
      .at(0)
    if (account !== undefined) {
      return { kind: "routed", account: account.name, models: route.models }
    }
  }
  return { kind: "waits", reason: pin === undefined ? "no account has room for the dispatch route" : "no account has room for the pinned model " + (typeof pin === "string" ? pin : pin.models.implementer) }
}

const routingProblem = (routing: DispatchRouting, accounts: ReadonlyArray<{ readonly name: string; readonly provider: string }>): string | null => {
  const candidates = [
    ...routing.rules.flatMap((rule) => rule.candidates),
    ...routing.default,
    ...Object.values(routing.tasks ?? {}).flatMap((task) => task.model === undefined ? [] : [task.model])
  ]
  for (const candidate of candidates) {
    const model = typeof candidate === "string" ? candidate : candidate.models.implementer
    const provider = providerOfModel(model)
    if (typeof candidate !== "string" && candidate.account !== undefined) {
      const account = accounts.find((entry) => entry.name === candidate.account)
      if (account === undefined) {
        return "routing names the unknown account " + candidate.account
      }
      if (provider !== account.provider) {
        return "routing names the account " + account.name + " on provider " + account.provider + " with model " + model + " from another provider"
      }
    } else if (!accounts.some((account) => account.provider === provider)) {
      return "routing names the provider " + provider + ", which has no quota account"
    }
  }
  return null
}

export const readRouting = (
  file: string,
  raw: unknown,
  accounts: ReadonlyArray<{ readonly name: string; readonly provider: string }>
): Effect.Effect<DispatchRouting, ConfigError> =>
  Schema.decodeUnknownEffect(DispatchRouting)(raw, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ConfigError({ file, detail: "routing: " + error.message })),
    Effect.flatMap((routing) => {
      const problem = routingProblem(routing, accounts)
      return problem === null ? Effect.succeed(routing) : Effect.fail(new ConfigError({ file, detail: problem }))
    })
  )
