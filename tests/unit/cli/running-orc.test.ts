import { expect, test } from "bun:test";
import { Effect } from "effect";
import { CommandRunner } from "@avi2dg/orc-schema";
import { localRunningOrc } from "@avi2dg/orc-cli";

test("the peer sends a count without queued Orc jobs or running jobs from another group", async () => {
  const running = { Running: { start: "2026-01-01T00:01:00Z" } };
  const task = (id: number, group: string, status: typeof running | { Queued: object }) => ({ id, group, command: "true", path: "/tmp", status });
  const tasks = { "1": task(1, "orc", running), "2": task(2, "other", running), "3": task(3, "orc", { Queued: {} }) };
  const report = await Effect.runPromise(localRunningOrc.pipe(Effect.provideService(CommandRunner, { run: ({ argv }) => {
    expect(argv).toEqual(["pueue", "status", "--json", "status=running"]);
    return Effect.succeed(JSON.stringify({ tasks, groups: {} }));
  } })));
  expect(report).toEqual({ schemaVersion: 1, count: { kind: "ok", value: 1 } });
});
