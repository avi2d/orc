#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Option, Runtime } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { snapshotSources } from "@tui-dash/schema";
import packageJson from "../package.json" with { type: "json" };
import { printAlertsJson, printSnapshotJson } from "./app";
import { alertCommandLive, snapshotSourcesLive } from "./live/layer";
import { dashboardHandler, frameFlags, panel } from "./panels";
import { report, sample } from "./reports";
import { sourcesNamed, unknownSources } from "./snapshot";

const snapshot = Command.make(
  "snapshot",
  {
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print the snapshot as one JSON object on one line"), Flag.withDefault(false)),
    only: Flag.String("only").pipe(
      Flag.withDescription(`Read only these sources, separated by commas, out of ${snapshotSources.join(", ")}`),
      Flag.filterMap(sourcesNamed, unknownSources),
      Flag.optional,
    ),
  },
  ({ json, only }) =>
    Effect.gen(function* () {
      if (!json) return yield* new CliError.UserError({ cause: "snapshot prints JSON alone, so run it as tui-dash snapshot --json" });
      yield* printSnapshotJson(Option.getOrElse(only, () => new Set(snapshotSources))).pipe(Effect.provide(snapshotSourcesLive));
    }),
).pipe(Command.withDescription("Read every source once and print what each answered, or why it failed"));

const alerts = Command.make(
  "alerts",
  { json: Flag.Boolean("json").pipe(Flag.withDescription("Print each alert event as one JSON object on its own line"), Flag.withDefault(false)) },
  ({ json }) =>
    Effect.gen(function* () {
      if (!json) return yield* new CliError.UserError({ cause: "alerts prints JSON lines alone, so run it as tui-dash alerts --json" });
      yield* printAlertsJson.pipe(
        Effect.provide(alertCommandLive),
        Effect.catchTag("ConfigRefused", ({ reason }) => Effect.fail(new CliError.UserError({ cause: reason }))),
      );
    }),
).pipe(Command.withDescription("Watch quota pace, machine load and long tasks, and print an event each time a rule fires"));

const tuiDash = Command.make("tui-dash", frameFlags, dashboardHandler).pipe(
  Command.withDescription("The live dashboard of the panels its config lays out, or one printed frame of it"),
  Command.withSubcommands([panel, report, sample, snapshot, alerts]),
);

// A source abandoned at its limit can stay blocked opening a file, which would keep the process alive after it prints.
BunRuntime.runMain(Command.run(tuiDash, { version: packageJson.version }).pipe(Effect.provide(BunServices.layer)), {
  teardown: (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code)),
});
