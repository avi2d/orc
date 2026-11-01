import { Data, Duration, Effect, Layer } from "effect";
import { acceptsExit, type Command, CommandRunner, CommandUnreachable } from "@tui-dash/schema";

const colourCode = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const reasonLimit = 300;

const stderrSummary = (stderr: string): string => {
  const joined = stderr
    .replaceAll(colourCode, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return joined.length > reasonLimit ? `${joined.slice(0, reasonLimit - 1)}\u2026` : joined;
};

const exitReason = (program: string, code: number, stderr: string): string => {
  const summary = stderrSummary(stderr);
  return summary === "" ? `${program} exited ${code}` : `${program} exited ${code}: ${summary}`;
};

class GroupGone extends Data.TaggedError("GroupGone") {}

// The group is already gone once every process in it has exited.
const signalGroup = (leader: number, signal: "SIGTERM" | "SIGKILL"): Effect.Effect<void> =>
  Effect.try({ try: () => process.kill(-leader, signal), catch: () => new GroupGone() }).pipe(
    Effect.asVoid,
    Effect.catchTag("GroupGone", () => Effect.void),
  );

const killGrace = Duration.seconds(1);

// Each command runs detached in its own group, so a group still in this set outlives the process unless it is killed.
const spawn = ({ argv, cwd, stdin }: Command, groups: Set<number>) =>
  Effect.tryPromise({
    try: (signal) => {
      // sh forks the command rather than exec'ing it, so a signal to sh alone leaves the command running.
      const child = Bun.spawn([...argv], {
        ...(cwd === undefined ? {} : { cwd }),
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      groups.add(child.pid);
      const stop = signalGroup(child.pid, "SIGTERM").pipe(
        Effect.andThen(Effect.sleep(killGrace)),
        Effect.andThen(signalGroup(child.pid, "SIGKILL")),
        Effect.ensuring(Effect.sync(() => groups.delete(child.pid))),
      );
      signal.addEventListener("abort", () => Effect.runFork(stop), { once: true });
      return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => {
        if (!signal.aborted) groups.delete(child.pid);
      });
    },
    catch: (cause) => new CommandUnreachable({ reason: `${argv[0]} did not start: ${String(cause)}` }),
  });

const runnerOf = (groups: Set<number>): CommandRunner["Service"] => ({
  run: (command) =>
    spawn(command, groups).pipe(
      Effect.timeoutOrElse({
        duration: command.timeout,
        orElse: () =>
          Effect.fail(
            new CommandUnreachable({
              reason: `${command.argv[0]} gave no answer within ${Duration.format(command.timeout)}`,
            }),
          ),
      }),
      Effect.flatMap(([code, stdout, stderr]) =>
        acceptsExit(command, code)
          ? Effect.succeed(stdout)
          : Effect.fail(new CommandUnreachable({ reason: exitReason(command.argv[0], code, stderr) })),
      ),
    ),
});

export const liveCommandRunner: Layer.Layer<CommandRunner> = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const groups = new Set<number>();
    yield* Effect.addFinalizer(() => Effect.forEach(groups, (leader) => signalGroup(leader, "SIGKILL"), { discard: true }));
    return runnerOf(groups);
  }),
);
