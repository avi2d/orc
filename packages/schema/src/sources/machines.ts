import { Config, type Duration, Effect } from "effect";
import { CommandRunner } from "../command";
import type { Outcome } from "../reading";
import { runDecoded } from "../source";
import { machineNames, selector } from "./environment";

export interface RemoteSource<A> {
  readonly name: string;
  readonly read: Effect.Effect<Outcome<A>>;
}

export interface Machines<A> {
  readonly local: string;
  readonly remotes: ReadonlyArray<RemoteSource<A>>;
}

const machinesConfig = (variable: string) => Config.all({ names: machineNames, command: selector(variable) });

// The configured command is a shell line, such as an ssh call, so the shell parses its quoting.
export const configuredMachines = <A>(
  variable: string,
  timeout: Duration.Duration,
  decode: (machine: string) => (stdout: string) => Outcome<A>,
): Effect.Effect<Machines<A>, Config.ConfigError, CommandRunner> =>
  Effect.gen(function* () {
    const { names, command } = yield* machinesConfig(variable);
    const runner = yield* CommandRunner;
    return {
      local: names.local,
      remotes:
        command === undefined
          ? []
          : [
              {
                name: names.remote,
                read: Effect.provideService(runDecoded({ argv: ["sh", "-c", command], timeout }, decode(names.remote)), CommandRunner, runner),
              },
            ],
    };
  });

export interface MachineReading<A> {
  readonly name: string;
  readonly reading: Outcome<A>;
}

// The other machines read beside this one, so the slowest sets the read's pace rather than their sum.
export const readBeside = <L, A, R>(
  local: Effect.Effect<L, never, R>,
  machines: Machines<A>,
): Effect.Effect<readonly [L, ReadonlyArray<MachineReading<A>>], never, R> =>
  Effect.all(
    [
      local,
      Effect.forEach(machines.remotes, (remote) => Effect.map(remote.read, (reading) => ({ name: remote.name, reading })), {
        concurrency: "unbounded",
      }),
    ],
    { concurrency: "unbounded" },
  );
