import { Array as Arr, Effect, type FileSystem, type Path, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import { finishAgentFile, readAgentFile, resolveAgentFile, type AgentFile, type PiThinkingLevel } from "../../entities/agent/index"
import type { HostTools, SandboxKind } from "../../shared/sandbox/index"
import { configuredModels, defaultCredentialOf, readOrcConfig, routeOfAgents, type OrcConfig, type ReviewerEntry, type RoutedModels, RoutedModelsJson, type RunDelivery } from "../../shared/config/index"
import { planSandbox, type SandboxPlan } from "./sandbox-plan"
import type { Checkout } from "../../entities/task-copy/index"
import { OrcRunError } from "../../shared/lib/index"
import { prepareRunFolders, type RunFolders } from "./run-folders"
import type { PreparedReviewer } from "./run-deliverer"

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

export interface PreparedAgents {
  readonly folders: RunFolders
  readonly agent: AgentFile
  readonly fixer: AgentFile
  readonly reviewer: PreparedReviewer
  readonly plan: SandboxPlan
  readonly planReviewer: (entry: ReviewerEntry, piAgentDir: string) => Effect.Effect<SandboxPlan, OrcRunError>
}

interface ModelPins {
  readonly tokenFile: string | undefined
  readonly provider: string | undefined
  readonly implementerModel: string | undefined
  readonly fixerModel: string | undefined
  readonly implementerThinking: PiThinkingLevel | undefined
  readonly fixerThinking: PiThinkingLevel | undefined
}

// A chain entry names its model, so the model line of the reviewer agent file gives way to it.
const chainReviewers = (
  parsed: Parameters<typeof finishAgentFile>[0],
  chain: Arr.NonEmptyReadonlyArray<ReviewerEntry>,
  config: Pick<OrcConfig, "file" | "providers">
) =>
  Effect.all(Arr.map(chain, (entry) =>
    Effect.gen(function*() {
      const provider = config.providers.find((candidate) => candidate.id === entry.provider)
      if (provider === undefined) {
        return yield* new OrcRunError({ message: "orc: " + config.file + " names the reviewer provider " + entry.provider + " among no providers" })
      }
      const reviewer = yield* finishAgentFile({ ...parsed, model: entry.model }, { configModel: { file: config.file, model: entry.model }, thinking: undefined })
      return { ...entry, reviewer, credential: defaultCredentialOf(provider, Bun.env, config.file) }
    })
  ))

export const prepareRoles = Effect.fnUntraced(function*(
  location: { readonly projectDir: string; readonly orcHome: string; readonly agentsDir: string | undefined },
  config: Pick<OrcConfig, "file" | "models" | "reviewers" | "providers">,
  delivery: RunDelivery | undefined,
  pins: Pick<ModelPins, "implementerModel" | "fixerModel" | "implementerThinking" | "fixerThinking">,
  route: RoutedModels | undefined
) {
  const configured = configuredModels(config, {
    implementer: pins.implementerModel ?? route?.implementer,
    fixer: pins.fixerModel ?? route?.fixer ?? route?.implementer
  })
  const implementerFile = yield* readAgentFile("implementer", location)
  const fixerFile = yield* readAgentFile("fixer", location)
  const configModel = (model: string | undefined) => ({ file: config.file, model })
  const agent = yield* finishAgentFile(implementerFile, { configModel: configModel(configured.implementer), thinking: pins.implementerThinking })
  const fixer = yield* finishAgentFile(fixerFile, { configModel: configModel(configured.fixer), thinking: pins.fixerThinking })
  const chain = delivery === "orc" ? config.reviewers : undefined
  const reviewer: PreparedReviewer = chain !== undefined
    ? { kind: "orc-chain", chain: yield* chainReviewers(yield* readAgentFile("reviewer", location), chain, config) }
    : delivery === "direct-PR" || delivery === "orc"
    ? { kind: delivery, reviewer: yield* resolveAgentFile("reviewer", { ...location, configModel: configModel(route?.reviewer ?? fixer.model) }) }
    : { kind: "no-mistakes" }
  return { agent, fixer, reviewer }
}, Effect.mapError((cause) => new OrcRunError({ message: cause.message })))

export const prepareAgents = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  checkout: Checkout,
  home: string,
  runDir: string,
  effectiveTaskFile: string,
  instructionsFile: string | null,
  agentsDir: string | undefined,
  sandboxKind: SandboxKind,
  delivery: RunDelivery | undefined,
  pins: ModelPins
): Effect.Effect<PreparedAgents, OrcRunError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read " + cause.file + ": " + cause.detail }))
    )
    const folders = yield* prepareRunFolders(fs, path, runDir, effectiveTaskFile, instructionsFile)
    const routeText = Bun.env.ORC_DISPATCH_ROUTED_MODELS
    const route = routeText === undefined ? undefined : yield* Schema.decodeEffect(RoutedModelsJson)(routeText, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read dispatched models: " + cause.message }))
    )
    const { agent, fixer, reviewer } = yield* prepareRoles({ projectDir: checkout.projectDir, orcHome: home, agentsDir }, config, delivery, pins, route)
    if (reviewer.kind === "orc-chain" && sandboxKind === "nono") {
      return yield* refuse("orc: " + config.file + " names a reviewer chain, whose reviewer runs on another provider than the implementer, and the nono sandbox carries one provider's credential, so run it with --sandbox none")
    }
    const piBinary = Bun.which("pi")
    const nodeBinary = Bun.which("node")
    const models = reviewer.kind === "direct-PR" || reviewer.kind === "orc" ? { agent: agent.model, fixer: fixer.model, reviewer: reviewer.reviewer.model } : { agent: agent.model, fixer: fixer.model }
    const provider = yield* Effect.fromResult(routeOfAgents(config, models, pins.provider)).pipe(Effect.mapError((message) => new OrcRunError({ message })))
    if (piBinary === null) {
      return yield* refuse("orc: pi is not on the host PATH")
    }
    if (nodeBinary === null) {
      return yield* refuse("orc: node is not on the host PATH")
    }
    const host: HostTools = { piBinary, nodeBinary, homeDir: homedir() }
    const plan = yield* planSandbox(fs, path, spawner, host, { projectDir: checkout.projectDir, runDir: folders.runDir, piAgentDir: folders.piAgentDir, orcHome: home }, models, { config, provider, tokenFileFlag: pins.tokenFile }, sandboxKind)
    const planReviewer = (entry: ReviewerEntry, piAgentDir: string): Effect.Effect<SandboxPlan, OrcRunError> =>
      Effect.gen(function*() {
        const reviewerProvider = config.providers.find((candidate) => candidate.id === entry.provider)
        if (reviewerProvider === undefined) {
          return yield* refuse("orc: " + config.file + " names the reviewer provider " + entry.provider + " among no providers")
        }
        yield* fs.makeDirectory(piAgentDir, { recursive: true }).pipe(
          Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the reviewer Pi folder " + piAgentDir + ": " + String(cause) }))
        )
        const reviewerModels = { agent: entry.model, fixer: entry.model }
        return yield* planSandbox(fs, path, spawner, host, { projectDir: checkout.projectDir, runDir: folders.runDir, piAgentDir, orcHome: home }, reviewerModels, { config, provider: reviewerProvider, tokenFileFlag: undefined }, sandboxKind)
      })
    return { folders, agent, fixer, reviewer, plan, planReviewer }
  })
