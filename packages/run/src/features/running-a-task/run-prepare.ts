import { Effect, type FileSystem, type Path, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import { finishAgentFile, readAgentFile, resolveAgentFile, type AgentFile, type PiThinkingLevel } from "../../entities/agent/index"
import type { HostTools, SandboxKind } from "../../shared/sandbox/index"
import { configuredModels, readOrcConfig, routeOfAgents, type OrcConfig, type RoutedModels, RoutedModelsJson, type RunDelivery } from "../../shared/config/index"
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
}

interface ModelPins {
  readonly tokenFile: string | undefined
  readonly provider: string | undefined
  readonly implementerModel: string | undefined
  readonly fixerModel: string | undefined
  readonly implementerThinking: PiThinkingLevel | undefined
  readonly fixerThinking: PiThinkingLevel | undefined
}

export const prepareRoles = Effect.fnUntraced(function*(
  location: { readonly projectDir: string; readonly orcHome: string; readonly agentsDir: string | undefined },
  config: Pick<OrcConfig, "file" | "models">,
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
  const reviewer: PreparedReviewer = delivery === "direct-PR"
    ? { kind: "direct-PR", reviewer: yield* resolveAgentFile("reviewer", { ...location, configModel: configModel(route?.reviewer ?? fixer.model) }) }
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
    const piBinary = Bun.which("pi")
    const nodeBinary = Bun.which("node")
    const models = reviewer.kind === "direct-PR" ? { agent: agent.model, fixer: fixer.model, reviewer: reviewer.reviewer.model } : { agent: agent.model, fixer: fixer.model }
    const provider = yield* Effect.fromResult(routeOfAgents(config, models, pins.provider)).pipe(Effect.mapError((message) => new OrcRunError({ message })))
    if (piBinary === null) {
      return yield* refuse("orc: pi is not on the host PATH")
    }
    if (nodeBinary === null) {
      return yield* refuse("orc: node is not on the host PATH")
    }
    const host: HostTools = { piBinary, nodeBinary, homeDir: homedir() }
    const plan = yield* planSandbox(fs, path, spawner, host, { projectDir: checkout.projectDir, runDir: folders.runDir, piAgentDir: folders.piAgentDir, orcHome: home }, models, { config, provider, tokenFileFlag: pins.tokenFile }, sandboxKind)
    return { folders, agent, fixer, reviewer, plan }
  })
