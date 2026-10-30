import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { printResourcesJson, resourceSourcesLive } from "@tui-dash/resources";
import { printComposedSessionQuotaJson, printSessionQuotaJson, sessionQuotaSourcesLive, streamSessionQuotaAlerts } from "@tui-dash/session-quota";
import { printTaskLiveJson, runSampler, tasksSourcesLive } from "@tui-dash/tasks";

const reportChoices = [
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
