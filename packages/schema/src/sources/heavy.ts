import { Config, Context, Duration, Effect, Layer, Schema } from "effect";
import { CommandRunner } from "../command";
import { decodeJson } from "../decode";
import type { Reading } from "../reading";
import { runDecoded, stamped } from "../source";
import { machineNames, selector } from "./environment";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const HeavyCall = Schema.Struct({ id: Count, command: Schema.String, ageMinutes: Count });

export const HeavyCheck = Schema.Struct({
  group: Schema.String,
  parallel: Count,
  running: Schema.Array(HeavyCall),
  queued: Schema.Array(HeavyCall),
  bypass: Count,
  bypassWeek: Count,
});

export type HeavyCheck = typeof HeavyCheck.Type;

export const decodeHeavyCheck = decodeJson(HeavyCheck);

export interface HeavyMachine {
  readonly name: string;
  readonly read: Effect.Effect<Reading<HeavyCheck>>;
}

export class HeavyMachines extends Context.Service<HeavyMachines, ReadonlyArray<HeavyMachine>>()("orc-dash/HeavyMachines") {}

const localTimeout = Duration.seconds(10);

const remoteTimeout = Duration.seconds(20);

// The queue and machines panels both show each machine's check, so a read this young serves the second one.
const reuseFor = Duration.seconds(5);

const heavyConfig = Config.all({ names: machineNames, command: selector("ORC_DASH_REMOTE_HEAVY") });

const machineOf = (
  name: string,
  argv: readonly [string, ...string[]],
  timeout: Duration.Duration,
  runner: CommandRunner["Service"],
): Effect.Effect<HeavyMachine> =>
  Effect.map(Effect.cachedWithTTL(Effect.provideService(stamped(runDecoded({ argv, timeout }, decodeHeavyCheck)), CommandRunner, runner), reuseFor), (read) => ({
    name,
    read,
  }));

// The configured command is a shell line, such as an ssh call, so the shell parses its quoting.
export const heavyMachinesLayer: Layer.Layer<HeavyMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  HeavyMachines,
  Effect.gen(function* () {
    const { names, command } = yield* heavyConfig;
    const runner = yield* CommandRunner;
    const local = yield* machineOf(names.local, ["orc", "heavy", "check", "--json"], localTimeout, runner);
    return command === undefined ? [local] : [local, yield* machineOf(names.remote, ["sh", "-c", command], remoteTimeout, runner)];
  }),
);
