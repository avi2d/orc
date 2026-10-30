import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { type ActionRun, ActionsSource, actionsSourceLayer, activeRuns, CommandRunner, decodeActions, ok, unreachable } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const run = (databaseId: number, status: ActionRun["status"]): ActionRun => ({
  databaseId,
  displayTitle: "fix(shop): keep the basket",
  status,
  workflowName: "ci",
  createdAt: DateTime.makeUnsafe("2026-10-18T00:20:11Z"),
});

describe("a gh run list answer", () => {
  test("decodes the recorded in progress runs", () => {
    expect(valueOf(decodeActions(fixture("github/runs-in_progress.json"))).map((each) => each.databaseId)).toEqual([39082000101, 39082000100]);
  });

  test("is invalid when a run carries no databaseId", () => {
    expect(issueOf(decodeActions(fixture("github/runs-changed.json")))).toContain("databaseId");
  });
});

describe("the active runs across the status calls", () => {
  test("keep a run that answered two calls once, at its later status", () => {
    const merged = valueOf(activeRuns([ok([run(7, "queued")]), ok([run(7, "in_progress"), run(8, "pending")])]));
    expect(merged.map((each) => [each.databaseId, each.status])).toEqual([
      [7, "in_progress"],
      [8, "pending"],
    ]);
  });

  test("keep the later status whichever call answered first", () => {
    const merged = valueOf(activeRuns([ok([run(7, "in_progress")]), ok([run(7, "queued")])]));
    expect(merged.map((each) => each.status)).toEqual(["in_progress"]);
  });

  test("fail as a whole when one call fails", () => {
    expect(activeRuns([ok([run(7, "queued")]), unreachable("gh exited 1: HTTP 401")]).kind).toBe("unreachable");
  });
});

const readTwice = async (env: Record<string, string>) => {
  const asked: Array<string> = [];
  const runner = Layer.succeed(CommandRunner, {
    run: (command) =>
      Effect.sync(() => {
        asked.push(command.argv.join(" "));
        return command.argv.includes("in_progress") ? fixture("github/runs-in_progress.json") : fixture("github/runs-none.json");
      }),
  });
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* ActionsSource;
      yield* source.read;
      return { repo: source.repo, runs: yield* source.read };
    }).pipe(Effect.provide(actionsSourceLayer.pipe(Layer.provide(runner), Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))))),
  );
  return { ...read, asked };
};

describe("the actions source", () => {
  test("asks gh about each active status of the configured repository, and reuses a fresh read", async () => {
    const { repo, runs, asked } = await readTwice({ TUI_DASH_ACTIONS_REPO: "example/shop" });
    expect(repo).toBe("example/shop");
    expect(valueOf(runs)).toHaveLength(2);
    const statuses = asked.map((line) => /--repo example\/shop --status (\S+) /u.exec(line)?.[1]);
    expect(statuses).toHaveLength(5);
    expect(new Set(statuses)).toEqual(new Set(["requested", "pending", "waiting", "queued", "in_progress"]));
  });

  for (const env of [{}, { TUI_DASH_ACTIONS_REPO: " " }]) {
    test(`leaves the repository to gh's working directory when the variable is ${JSON.stringify(env)}`, async () => {
      const { repo, asked } = await readTwice(env);
      expect(repo).toBe("this repository");
      expect(asked).toHaveLength(5);
      expect(asked.filter((line) => line.includes("--repo"))).toEqual([]);
    });
  }
});
