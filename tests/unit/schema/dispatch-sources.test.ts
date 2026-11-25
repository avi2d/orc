import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { DispatchSource, dispatchSourceLayer } from "@avi2dg/orc-schema";
import { emptyBacklogStdout, orcBacklogPrinting } from "../../lib/dispatch-fixture";

const root = mkdtempSync(join(tmpdir(), "orc-dash-dispatch-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

let folders = 0;

const machine = { name: "mac", slots: 1, start: ["true"] as const };
const quota = { provider: "acme", command: ["run"], floorPercent: 50 };

const backlogWith = (dispatch: unknown): string => {
  folders += 1;
  const home = join(root, String(folders));
  const folder = join(home, "backlog");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "dispatch.json"), JSON.stringify(dispatch));
  writeFileSync(join(folder, "projects.json"), JSON.stringify({ projects: [] }));
  return home;
};

const machinesAt = (backlog: string) =>
  Effect.runPromise(
    Effect.map(Effect.flatMap(DispatchSource, (source) => source.read), (reading) => reading.snapshot.machines).pipe(
      Effect.provide(
        dispatchSourceLayer.pipe(
          Layer.provide(BunFileSystem.layer),
          Layer.provide(orcBacklogPrinting(emptyBacklogStdout)),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ORC_HOME: backlog, HOME: root }))),
        ),
      ),
    ),
  );

describe("the dispatch panel reader", () => {
  test("reads the README kind none dispatch.json instead of reporting it unread", async () => {
    const machines = await machinesAt(backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", kind: "none" }] } }));
    expect(machines.kind).toBe("ok");
    if (machines.kind === "ok") expect(machines.value).toEqual([{ ...machine }]);
  });
  test("keeps a legacy token file account instead of reporting it unread", async () => {
    const machines = await machinesAt(backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenFile: "/secrets/main-token" }] } }));
    expect(machines.kind).toBe("ok");
  });
  test("refuses a token command account while a machine has no renew instead of reporting room", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenCommand: ["my-token-command", "main"] }] } }),
    );
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") expect(machines.reason).toContain("has no renew command");
  });
  test("refuses a kind none account next to a machine renew instead of reporting room", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [{ ...machine, renew: ["true"] as const }], quota: { ...quota, accounts: [{ name: "main", kind: "none" }] } }),
    );
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") {
      expect(machines.reason).toContain("the machine mac names a renew command it never takes, because no account uses a token command");
    }
  });
  test("refuses a kind none account with a misspelt key instead of reporting the machines as healthy", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", kind: "none", tokenfile: "/secrets/main-token" }] } }),
    );
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") expect(machines.reason).toContain("tokenfile");
  });
  test("refuses a legacy account with an unknown key instead of reporting the machines as healthy", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenFile: "/a", note: "x" }] } }),
    );
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") expect(machines.reason).toContain("note");
  });
  test("refuses a second account beside a kind none account instead of spending the wrong login", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", kind: "none" }, { name: "alt", kind: "none" }] } }),
    );
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") {
      expect(machines.reason).toContain("the account main takes kind none and names no login");
      expect(machines.reason).toContain("no other account runs on its provider acme, but alt does");
    }
  });
  test("refuses a token account beside a kind none account instead of spending the wrong login", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenFile: "/a" }, { name: "alt", kind: "none" }] } }),
    );
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") expect(machines.reason).toContain("the account alt takes kind none and names no login");
  });
  test("keeps kind none accounts on providers no other account runs on instead of refusing a login per provider", async () => {
    const openai = { name: "openai", provider: "codex", models: { implementer: "codex/gpt-5.5", fixer: "codex/gpt-5.5" }, kind: "none" };
    const go = { name: "go", provider: "opencode-go", models: { implementer: "opencode-go/kimi-k2", fixer: "opencode-go/kimi-k2" }, kind: "none" };
    const machines = await machinesAt(backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenFile: "/a" }, openai, go] } }));
    expect(machines.kind).toBe("ok");
  });
  test("refuses a kind none account beside another account on its own provider instead of spending one login twice", async () => {
    const models = { implementer: "codex/gpt-5.5", fixer: "codex/gpt-5.5" };
    const accounts = [{ name: "main", tokenFile: "/a" }, { name: "openai", provider: "codex", models, kind: "none" }, { name: "openai-2", provider: "codex", models, tokenFile: "/b" }];
    const machines = await machinesAt(backlogWith({ machines: [machine], quota: { ...quota, accounts } }));
    expect(machines.kind).toBe("unreachable");
    if (machines.kind === "unreachable") expect(machines.reason).toContain("the account openai takes kind none and names no login, so no other account runs on its provider codex, but openai-2 does");
  });
  test("keeps the renew command a token command account needs beside a kind none account on another provider instead of calling it dead", async () => {
    const openai = { name: "openai", provider: "codex", models: { implementer: "codex/gpt-5.5", fixer: "codex/gpt-5.5" }, kind: "none" };
    const machines = await machinesAt(
      backlogWith({ machines: [{ ...machine, renew: ["true"] as const }], quota: { ...quota, accounts: [{ name: "main", tokenCommand: ["my-token-command", "main"] }, openai] } }),
    );
    expect(machines.kind).toBe("ok");
  });
  test("keeps an account with its own provider and models instead of reporting them as unknown keys", async () => {
    const openai = { name: "openai", provider: "codex", models: { implementer: "codex/gpt-5.5", fixer: "codex/gpt-5.5" }, tokenFile: "/b" };
    const machines = await machinesAt(backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenFile: "/a" }, openai] } }));
    expect(machines.kind).toBe("ok");
  });
  test("keeps several token accounts when no account is kind none", async () => {
    const machines = await machinesAt(
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenFile: "/a" }, { name: "alt", tokenFile: "/b" }] } }),
    );
    expect(machines.kind).toBe("ok");
  });
});
