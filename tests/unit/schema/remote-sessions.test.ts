import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import {
  type Command,
  CommandRunner,
  CommandUnreachable,
  composedSessionQuota,
  composedSessionQuotaReport,
  decodeRemoteSessionQuota,
  SessionMachines,
  sessionMachinesLayer,
} from "@tui-dash/schema";
import { machineReport, machineStdout, machineView, southReading } from "../../lib/machines-fixture";
import { issueOf, valueOf } from "../../lib/outcomes";

const machinesWith = (env: Record<string, string>, answer: (command: Command) => Effect.Effect<string, CommandUnreachable>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const machines = yield* SessionMachines;
      const readings = yield* Effect.forEach(machines.remotes, (remote) => remote.read);
      return { local: machines.local, names: machines.remotes.map((remote) => remote.name), readings };
    }).pipe(
      Effect.provide(
        sessionMachinesLayer.pipe(
          Layer.provide(Layer.succeed(CommandRunner, { run: answer })),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        ),
      ),
    ),
  );

const remoteCommand = "ssh south.example.com 'cd tui-dash && bun run session-quota-json'";

const configured = { TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_SESSION_QUOTA: remoteCommand };

describe("the remote session source", () => {
  test("reads nothing remote when no command is configured", async () => {
    const asked: Array<Command> = [];
    const found = await machinesWith({}, (command) => {
      asked.push(command);
      return Effect.succeed("");
    });
    expect(found).toEqual({ local: "local", names: [], readings: [] });
    expect(asked).toEqual([]);
  });

  test("treats a blank command as none", async () => {
    expect((await machinesWith({ TUI_DASH_REMOTE_SESSION_QUOTA: "  " }, () => Effect.succeed(""))).names).toEqual([]);
  });

  // The line goes to the shell whole, so its quotes survive.
  test("hands the configured line to the shell and reads the remote's report as its machine", async () => {
    const asked: Array<Command> = [];
    const found = await machinesWith(configured, (command) => {
      asked.push(command);
      return Effect.succeed(machineStdout("south"));
    });
    expect(asked.map((command) => command.argv)).toEqual([["sh", "-c", remoteCommand]]);
    expect(found.local).toBe("north");
    const view = valueOf(found.readings[0] ?? { kind: "invalid", issue: "no reading" });
    expect(view.sessions.map((session) => session.machine)).toEqual(["south", "south"]);
  });

  test("passes on the reason a remote command failed", async () => {
    const found = await machinesWith(configured, () =>
      Effect.fail(new CommandUnreachable({ reason: "sh exited 255: ssh: Could not resolve hostname south.example.com" })),
    );
    expect(found.readings).toEqual([{ kind: "unreachable", reason: "sh exited 255: ssh: Could not resolve hostname south.example.com" }]);
  });
});

describe("a remote's printed report", () => {
  test("reads a report printed across many lines", () => {
    const view = valueOf(decodeRemoteSessionQuota("south")(`\n${JSON.stringify(machineReport("south"), null, 2)}\n\n`));
    expect(view.accounts.map((account) => account.title)).toEqual(["claude work", "opencode-go"]);
  });

  test("refuses a banner printed before the report, which belongs on stderr", () => {
    expect(issueOf(decodeRemoteSessionQuota("south")(`Welcome to south\n${machineStdout("south")}`))).toBe("the output is not JSON");
  });

  test("refuses output that is not JSON", () => {
    expect(issueOf(decodeRemoteSessionQuota("south")("bash: tui-dash-session-quota: command not found\n"))).toBe(
      "the output is not JSON",
    );
  });

  // A remote composing its own remote would count a machine twice.
  test("refuses a composed version 2 report, since only a machine's own report composes", () => {
    const composedLine = JSON.stringify(composedSessionQuotaReport(composedSessionQuota(machineView("south"), "south", [southReading()]), "south"));
    expect(issueOf(decodeRemoteSessionQuota("south")(composedLine))).toContain("schemaVersion");
  });
});
