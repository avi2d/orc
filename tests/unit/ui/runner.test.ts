import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Exit } from "effect";
import { CommandRunner } from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const settles = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (!isRunning(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
};

const readPid = (pidFile: string): number | undefined => {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const readSleeperPid = async (pidFile: string): Promise<number> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pid = readPid(pidFile);
    if (pid !== undefined) return pid;
    await Bun.sleep(50);
  }
  throw new Error(`the command never wrote its pid to ${pidFile}`);
};

describe("the live command runner", () => {
  // Oracle: POSIX pwd -P prints the physical working directory the process was started in.
  // Rejects a runner that drops the folder and runs every command where the dashboard started.
  test("a command with a folder runs inside it", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "runner-")));
    try {
      const printed = await Effect.runPromise(
        CommandRunner.use((runner) => runner.run({ argv: ["pwd", "-P"], cwd: scratch, timeout: Duration.seconds(5) })).pipe(Effect.provide(liveCommandRunner)),
      );
      expect(printed.trim()).toBe(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Oracle: POSIX cat copies its standard input to its standard output and stops at end of file.
  // Rejects a runner that drops the stdin text, or leaves the input open so cat waits for the timeout.
  test("a command's stdin reaches the child and ends there", async () => {
    const printed = await Effect.runPromise(
      CommandRunner.use((runner) => runner.run({ argv: ["cat"], stdin: "the message\n", timeout: Duration.seconds(5) })).pipe(Effect.provide(liveCommandRunner)),
    );
    expect(printed).toBe("the message\n");
  });

  // Oracle: POSIX cat stops at end of file, which a closed input gives at once.
  // Rejects a runner that leaves a command without stdin reading an open input until its timeout.
  test("a command without stdin runs with its input closed", async () => {
    const printed = await Effect.runPromise(
      CommandRunner.use((runner) => runner.run({ argv: ["sh", "-c", "cat; echo done"], timeout: Duration.seconds(5) })).pipe(Effect.provide(liveCommandRunner)),
    );
    expect(printed).toBe("done\n");
  });

  test("a command cut off at its timeout takes the processes it started with it", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "runner-"));
    const pidFile = join(scratch, "pid");
    try {
      const run = CommandRunner.use((runner) =>
        runner.run({
          argv: ["sh", "-c", `sleep 37 & echo $! > ${pidFile}; wait`],
          timeout: Duration.seconds(3),
        }),
      ).pipe(Effect.provide(liveCommandRunner));

      const exit = await Effect.runPromiseExit(run);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await settles(await readSleeperPid(pidFile))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  // Oracle: POSIX keeps an ignored signal ignored across fork and exec, so only SIGKILL ends a command that traps TERM.
  // Rejects a runner that sends SIGTERM alone and leaves the command running.
  test("a command that ignores SIGTERM past its timeout is killed after the grace period", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "runner-"));
    const pidFile = join(scratch, "pid");
    try {
      const runThenWatch = Effect.gen(function* () {
        const runner = yield* CommandRunner;
        const exit = yield* Effect.exit(runner.run({ argv: ["sh", "-c", `trap "" TERM; sleep 38 & echo $! > ${pidFile}; wait`], timeout: Duration.seconds(3) }));
        const sleeper = yield* Effect.promise(() => readSleeperPid(pidFile));
        const stillRunning = isRunning(sleeper);
        return { failed: Exit.isFailure(exit), stillRunning, settled: yield* Effect.promise(() => settles(sleeper)) };
      }).pipe(Effect.provide(liveCommandRunner));

      expect(await Effect.runPromise(runThenWatch)).toEqual({ failed: true, stillRunning: true, settled: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  // Oracle: the recorded decision that stopping the stream kills every in-flight command group.
  // Rejects a runner whose detached commands outlive the scope that provided it.
  test("closing the runner's scope kills a command still in flight that ignores SIGTERM", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "runner-"));
    const pidFile = join(scratch, "pid");
    try {
      const inFlight = Effect.gen(function* () {
        const runner = yield* CommandRunner;
        yield* Effect.forkDetach(runner.run({ argv: ["sh", "-c", `trap "" TERM; sleep 39 & echo $! > ${pidFile}; wait`], timeout: Duration.minutes(1) }));
        yield* Effect.promise(() => readSleeperPid(pidFile));
      }).pipe(Effect.provide(liveCommandRunner));

      await Effect.runPromise(inFlight);

      expect(await settles(await readSleeperPid(pidFile))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
