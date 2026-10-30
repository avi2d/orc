import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { DispatchSource, dispatchSourceLayer } from "@tui-dash/schema";

const root = mkdtempSync(join(tmpdir(), "tui-dash-dispatch-"));

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
      backlogWith({ machines: [machine], quota: { ...quota, accounts: [{ name: "main", tokenCommand: ["clauth-token", "main"] }] } }),
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
      expect(machines.reason).toContain("takes kind none and holds no token");
      expect(machines.reason).toContain("names a renew command it never takes");
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
});
