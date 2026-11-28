import { Console, Effect, Layer } from "effect";
import { queueSourcesLive } from "@avi2dg/orc-queues";
import { readSubscriptions } from "@avi2dg/orc-schema";
import { readSubscriptionOverview } from "./subscription-overview";
import { machineOverview } from "./machine-overview";
import { liveCommandRunner } from "@avi2dg/orc-ui";
import { localRunningOrc } from "./running-orc";
import { Argument, Command } from "effect/cli";
import { printResourcesJson, resourceSourcesLive } from "@avi2dg/orc-resources";
import { printComposedSessionQuotaJson, printSessionQuotaJson, sessionQuotaSourcesLive, streamSessionQuotaAlerts } from "@avi2dg/orc-session-quota";
import { printTaskLiveJson, runSampler, tasksSourcesLive } from "@avi2dg/orc-tasks";

const reportChoices = [
  ["subscriptions", Effect.flatMap(readSubscriptions, (report) => Console.log(JSON.stringify(report))).pipe(Effect.provide(sessionQuotaSourcesLive))],
  ["subscription-overview", Effect.flatMap(readSubscriptionOverview, (report) => Console.log(JSON.stringify(report))).pipe(Effect.provide(Layer.merge(sessionQuotaSourcesLive, liveCommandRunner)))],
  ["machine-overview", Effect.flatMap(machineOverview, (report) => Console.log(JSON.stringify(report))).pipe(Effect.provide(Layer.mergeAll(resourceSourcesLive, queueSourcesLive, liveCommandRunner)))],
  ["running-orc", Effect.flatMap(localRunningOrc, (reading) => Console.log(JSON.stringify(reading))).pipe(Effect.provide(liveCommandRunner))],
  ["session-quota", printSessionQuotaJson.pipe(Effect.provide(sessionQuotaSourcesLive))],
  ["session-quota-composed", printComposedSessionQuotaJson.pipe(Effect.provide(sessionQuotaSourcesLive))],
  ["session-quota-alerts", streamSessionQuotaAlerts.pipe(Effect.provide(sessionQuotaSourcesLive))],
  ["resources", printResourcesJson.pipe(Effect.provide(resourceSourcesLive))],
  ["tasks-live", printTaskLiveJson.pipe(Effect.provide(tasksSourcesLive))],
] as const;

const samplerChoices = [["tasks", runSampler.pipe(Effect.provide(tasksSourcesLive))]] as const;

const choiceOf = <const C extends ReadonlyArray<readonly [string, unknown]>>(name: string, what: string, choices: C) =>
  Argument.ChoiceWithValue(name, choices).pipe(Argument.withDescription(`${what}, one of ${choices.map(([choice]) => choice).join(", ")}`));

export const report = Command.make("report", { run: choiceOf("report", "The report to print", reportChoices) }, ({ run }) => run).pipe(
  Command.withDescription("Print one panel's readings as JSON, or stream the session quota alerts"),
);

export const sample = Command.make("sample", { run: choiceOf("sampler", "The sampler to run", samplerChoices) }, ({ run }) => run).pipe(
  Command.withDescription("Record samples continuously for the panels that chart them"),
);
