import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { type Config, ConfigProvider, Effect, Fiber, Layer } from "effect";
import { type ModuleSources, moduleFeeds, modules } from "@tui-dash/cli";
import type { CliRenderer } from "@opentui/core";
import { dashboardScreen, printDashboard } from "@tui-dash/dashboard";
import {
  actionsSourceLayer,
  ciRunsLayer,
  type Command,
  CommandRunner,
  type CommandUnreachable,
  type ConfigRefused,
  dispatchSourceLayer,
  gpuSourceLayer,
  herdrSourceLayer,
  linuxDiskSourceLayer,
  linuxHarnessProcessSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  linuxTaskProcessesSourceLayer,
  localTasksLayer,
  loopTick,
  macDiskSourceLayer,
  macHostSourceLayer,
  macProcessesSourceLayer,
  machineSchedulesLayer,
  noMistakesMachinesLayer,
  orcMachinesLayer,
  pueueMachinesLayer,
  quotaSourceLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
  resourceMachinesLayer,
  runnerReposLayer,
  type RunnerRepos,
  sessionMachinesLayer,
  type TaskSamples,
  TaskSamplesSource,
  tasksMachinesLayer,
  noSavedReadings,
  readConfig,
  ReadModeReference,
  type SavedReadings,
} from "@tui-dash/schema";
import { liveScreen, type PanelError, type PanelModule, type PrintFrame } from "@tui-dash/ui";
import { type ConversationReader, ConversationSource, conversationSourceLive } from "@tui-dash/ledger";
import { harvestLogSourceLive, sessionLogSourceLive } from "@tui-dash/session-quota";
import { fixture } from "./fixtures";
import { fixtureActionsRepo, queueAnswers } from "./queues-fixture";
import { fixtureHomeEnvironment } from "./session-fixture";
import { isSavedProfilesCall, recordedSavedProfilesLayer } from "./saved-profiles";

export const tasksCommand = "tasks-report --json";

const recordedAnswers: ReadonlyArray<readonly [string, string]> = [
  ["sysctl -n", fixture("mac/sysctl.txt")],
  ["vm_stat", fixture("mac/vm_stat.txt")],
  ["ps -A", fixture("mac/ps.txt")],
  ["top -l 2", fixture("mac/top.txt")],
  ["cat /proc/loadavg", fixture("linux/loadavg.txt")],
  ["getconf _NPROCESSORS_ONLN", fixture("linux/nprocessors-onln.txt")],
  ["cat /proc/meminfo", fixture("linux/meminfo.txt")],
  ["df -kP /", fixture("linux/df.txt")],
  ["sh -c df -kP", fixture("mac/df.txt")],
  ["sh -c head -n 1", fixture("linux/stat.txt")],
  ["sh -c sample()", fixture("linux/proc-stat-cmdline.txt")],
  ["nvidia-smi --query-gpu", fixture("linux/gpu.csv")],
  ["nvidia-smi --query-compute-apps", fixture("linux/gpu-apps.csv")],
  ["herdr agent list", fixture("session-logs/herdr-agents.json")],
  ["sh -c for d in /proc", fixture("session-logs/harness-processes.txt")],
  ['sh -c set -e; printf "pagesize', fixture("linux/task-processes.txt")],
  ["systemctl --user list-timers", "[]"],
  [`sh -c ${tasksCommand}`, fixture("tasks/east.json")],
  ...queueAnswers,
];

export const recordedAnswer = (command: Command): string => {
  if (command.argv[0] === "quota-axi") return fixture("quota-axi/full.json");
  if (isSavedProfilesCall(command)) return fixture("saved-profiles/status.json");
  return recordedAnswers.find(([asked]) => command.argv.join(" ").startsWith(asked))?.[1] ?? "";
};

const alertFixtures = join(import.meta.dir, "..", "fixtures", "alerts");

export interface DashboardSourcesOptions {
  readonly run: (command: Command) => Effect.Effect<string, CommandUnreachable>;
  readonly env?: Record<string, string>;
  readonly saved?: Layer.Layer<SavedReadings, Config.ConfigError>;
  readonly samples?: TaskSamples;
  readonly config?: string;
  readonly conversation?: ConversationReader;
  readonly repos?: Layer.Layer<RunnerRepos, Config.ConfigError, CommandRunner>;
}

const noSamples: TaskSamples = { read: () => Effect.succeed([]), append: () => Effect.void };

// The program reads its own configuration too, such as the machine's name the tasks levels go by, so it sees the same variables.
export const dashboardSources = ({
  run,
  env = {},
  saved = noSavedReadings,
  samples = noSamples,
  config = join(alertFixtures, "..", "config", "config.json"),
  conversation,
  repos = runnerReposLayer,
}: DashboardSourcesOptions): Layer.Layer<ModuleSources, Config.ConfigError | ConfigRefused> =>
  moduleFeeds.pipe(Layer.provideMerge(recordedSources(run, env, saved, samples, config, conversation, repos)));

const recordedSources = (
  run: DashboardSourcesOptions["run"],
  env: Record<string, string>,
  saved: Layer.Layer<SavedReadings, Config.ConfigError>,
  samples: TaskSamples,
  config: string,
  conversation: ConversationReader | undefined,
  repos: Layer.Layer<RunnerRepos, Config.ConfigError, CommandRunner>,
) =>
  Layer.mergeAll(
    quotaSourceLayer,
    recordedSavedProfilesLayer,
    macHostSourceLayer,
    macProcessesSourceLayer,
    macDiskSourceLayer,
    linuxHostSourceLayer,
    linuxProcessesSourceLayer,
    linuxDiskSourceLayer,
    gpuSourceLayer,
    herdrSourceLayer,
    linuxHarnessProcessSourceLayer,
    linuxTaskProcessesSourceLayer,
    Layer.mergeAll(
      sessionMachinesLayer,
      resourceMachinesLayer,
      pueueMachinesLayer,
      actionsSourceLayer,
      localTasksLayer,
      tasksMachinesLayer,
      noMistakesMachinesLayer,
      orcMachinesLayer,
      remoteTaskHistoryLayer,
      remoteTaskLiveLayer,
      Layer.mergeAll(ciRunsLayer, machineSchedulesLayer("linux")).pipe(Layer.provideMerge(repos)),
    ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_ACTIONS_REPO: fixtureActionsRepo, ...env })))),
    Layer.succeed(TaskSamplesSource, samples),
    dispatchSourceLayer.pipe(Layer.provide(BunFileSystem.layer)),
    saved,
    conversation === undefined ? conversationSourceLive : Layer.succeed(ConversationSource, conversation),
  ).pipe(
    Layer.merge(
      Layer.mergeAll(sessionLogSourceLive, harvestLogSourceLive).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(fixtureHomeEnvironment))),
      ),
    ),
    Layer.provide(Layer.succeed(CommandRunner, { run })),
    Layer.merge(
      Layer.merge(
        BunFileSystem.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            ...env,
            HOME: "/home/tester",
            TUI_DASH_CONFIG: config,
            TUI_DASH_ALERTS_VERDICTS: join(alertFixtures, "verdicts.jsonl"),
          }),
        ),
      ),
    ),
  );

export const frameWhere = async (setup: TestRendererSetup, matches: (frame: string) => boolean): Promise<string> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await Bun.sleep(25);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (matches(frame)) return frame;
  }
  throw new Error(`no frame matched, last was:\n${setup.captureCharFrame()}`);
};

// Feeds choose live or print reads as they are built, so the read mode is provided outside the sources.
type DashboardError = PanelError | ConfigRefused | Config.ConfigError;

export const liveDashboard = (renderer: CliRenderer, sources: Layer.Layer<ModuleSources, Config.ConfigError | ConfigRefused>): Effect.Effect<void, DashboardError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { config } = yield* readConfig;
      yield* liveScreen(renderer, yield* dashboardScreen(modules, config), loopTick);
    }),
  ).pipe(Effect.provide(sources), Effect.provideService(ReadModeReference, "live"));

export const printedDashboard = (frame: PrintFrame, sources: Layer.Layer<ModuleSources, Config.ConfigError | ConfigRefused>): Effect.Effect<void, DashboardError> =>
  Effect.flatMap(readConfig, ({ config }) => printDashboard(modules, config, frame)).pipe(Effect.provide(sources), Effect.provideService(ReadModeReference, "print"));

export const printedPanel = (
  module: PanelModule<ModuleSources>,
  frame: PrintFrame,
  sources: Layer.Layer<ModuleSources, Config.ConfigError | ConfigRefused>,
): Effect.Effect<void, DashboardError> =>
  Effect.flatMap(readConfig, ({ config }) => module.print(config.panels[module.id], frame)).pipe(
    Effect.provide(sources),
    Effect.provideService(ReadModeReference, "print"),
  );

export const withLivePanel = async <A>(
  size: { readonly width: number; readonly height: number },
  sources: Layer.Layer<ModuleSources, Config.ConfigError | ConfigRefused>,
  body: (setup: TestRendererSetup) => Promise<A>,
): Promise<A> => {
  const setup = await createTestRenderer(size);
  const fiber = Effect.runFork(liveDashboard(setup.renderer, sources));
  try {
    return await body(setup);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    await setup.dispose();
  }
};
