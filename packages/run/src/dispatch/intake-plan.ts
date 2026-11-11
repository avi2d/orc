import { Duration, Effect, type FileSystem, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { providerEnvOf } from "../model-route"
import { readOrcConfig } from "../orc-config"
import { capture } from "./runner-exec"
import { type PlanDocument, readPlanDocument, splitDocumentSchema } from "./split"

const childBudget = "about 300 changed lines or one area"

const planSeconds = 300

export type IntakePlan =
  | { readonly kind: "off" }
  | { readonly kind: "planned"; readonly plan: PlanDocument }
  | { readonly kind: "unplanned"; readonly reason: string }

const planPrompt = (body: string): string =>
  [
    "You plan one request for orc before any worker starts on it. The request sits between the two lines of dashes below.",
    "The budget for one task is " + childBudget + ".",
    "When the request fits the budget, print {\"schema\":\"" + splitDocumentSchema + "\",\"plan\":\"whole\",\"reason\":\"<why it fits>\"}.",
    "When it does not, split it into vertical slices: each child is useful, testable and observable on its own, is one small PR in one area within the budget, and merges to main on its own.",
    "Then print {\"schema\":\"" + splitDocumentSchema + "\",\"plan\":\"split\",\"reason\":\"<why it does not fit>\",\"done\":[\"<each done criterion of the whole request>\"],\"children\":[{\"title\":\"<one line>\",\"body\":\"<what the slice changes and how it is checked>\",\"after\":[<the numbers, from 1, of earlier children it needs merged first>]}]}.",
    "Give at least two children. Leave after empty for a child that needs no other, so independent children run at the same time.",
    "Print only the JSON document.",
    "----------",
    body.trim(),
    "----------"
  ].join("\n")

const planCommand = (model: string, body: string): readonly [string, ...Array<string>] =>
  ["pi", "--print", "--model", model, "--no-tools", "--no-session", "--no-context-files", planPrompt(body)]

export const planIntake = (
  home: string,
  body: string
): Effect.Effect<IntakePlan, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home)
    const model = config.models?.planner
    if (model === undefined) {
      return { kind: "off" } satisfies IntakePlan
    }
    const ran = yield* capture(planCommand(model, body), null, providerEnvOf(config, model))
    if (ran.exitCode !== 0) {
      const said = ran.stderr.trim().split("\n").at(-1) ?? ""
      return { kind: "unplanned", reason: "the planner on " + model + " exited " + ran.exitCode + (said === "" ? "" : ": " + said) } satisfies IntakePlan
    }
    const read = readPlanDocument(ran.stdout)
    return Result.isSuccess(read)
      ? { kind: "planned", plan: read.success } satisfies IntakePlan
      : { kind: "unplanned", reason: "the planner on " + model + " " + read.failure } satisfies IntakePlan
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(planSeconds),
      orElse: () => Effect.succeed<IntakePlan>({ kind: "unplanned", reason: "the planner ran past " + planSeconds + " seconds" })
    }),
    Effect.catchTags({
      ConfigError: (error) => Effect.succeed<IntakePlan>({ kind: "unplanned", reason: error.file + ": " + error.detail }),
      RunnerError: (error) => Effect.succeed<IntakePlan>({ kind: "unplanned", reason: "the planner could not start: " + error.detail })
    })
  )
