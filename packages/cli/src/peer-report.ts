import { Duration, Effect } from "effect";
import { CommandRunner, type Outcome, unreachable } from "@avi2dg/orc-schema";

type Report = "running-orc" | "subscriptions";
const unsupported = "orc-dash:peer-report-unsupported";
const sshCommand = /^((?:\/[\w./-]+\/)?ssh(?: [\w@./:=+-]+)+) (?:'([^']+)'|"([^"]+)"|([^'"]+))$/u;

const peer = (command: string | undefined) => {
  const match = sshCommand.exec(command?.trim() ?? "");
  if (match?.[1] === undefined) return undefined;
  return { transport: match[1], remote: match.slice(2).find((part) => typeof part === "string") };
};

const checkoutCommand = /^(cd [\w./-]+ && (?:PATH=\$HOME\/[\w./-]+:\$PATH )?)bun run session-quota-json$/u;
const cliCommand = /^(bun (?:[\w./-]+\/)?packages\/cli\/src\/bin\.ts report) session-quota$/u;

export const peerReport = (report: Report, command: string | undefined, quotaCommand?: string): readonly [string, ...string[]] | undefined => {
  const target = peer(command);
  if (target === undefined) return undefined;
  const quota = report === "subscriptions" ? target : peer(quotaCommand);
  if (report === "running-orc" && target.remote !== "pueue status --json") return undefined;
  const remote = quota?.transport === target.transport ? quota.remote ?? "" : "";
  const checkout = checkoutCommand.exec(remote)?.[1];
  const cli = cliCommand.exec(remote)?.[1];
  if (report === "subscriptions" && checkout === undefined && cli === undefined && remote !== "orc-dash report session-quota") return undefined;
  const invoke = checkout === undefined ? cli ?? "orc-dash report" : checkout + "bun packages/cli/src/bin.ts report";
  const [ssh, ...args] = target.transport.split(" ");

  const missing = `if ${invoke} --help 2>/dev/null | grep -qw ${report}; then exit 1; else printf '%s\\n' '${unsupported}'; fi`;
  return [ssh, ...args, `(${invoke} ${report}) || { ${missing}; }`] as const;
};

export const preferPeerReport = <A>(
  argv: readonly [string, ...string[]] | undefined,
  timeout: Duration.Duration,
  decode: (text: string) => Outcome<A>,
  legacy: Effect.Effect<Outcome<A>>,
): Effect.Effect<Outcome<A>, never, CommandRunner> => argv === undefined ? legacy : Effect.gen(function* () {
  const runner = yield* CommandRunner;
  return yield* runner.run({ argv, timeout }).pipe(
    Effect.flatMap((stdout) => stdout.trim().endsWith(unsupported) ? legacy : Effect.succeed(decode(stdout))),
    Effect.catchTags({
      CommandAbsent: (error) => Effect.succeed(unreachable(error.reason)),
      CommandUnreachable: (error) => Effect.succeed(unreachable(error.reason)),
    }),
  );
});
