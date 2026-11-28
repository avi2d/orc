import { expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { CommandRunner, ok } from "@avi2dg/orc-schema";
import { peerReport, preferPeerReport } from "@avi2dg/orc-cli";

for (const report of ["subscriptions", "running-orc"] as const) {
  const command = report === "subscriptions" ? "ssh example 'orc-dash report session-quota'" : "ssh example 'pueue status --json'";
  const withPeer = async (installed: boolean) => {
    const argv = peerReport(report, command);
    if (!argv) throw new Error("Missing report command");
    let legacyReads = 0;
    const result = await Effect.runPromise(preferPeerReport(argv, Duration.seconds(20), (text) => ok(text.trim()),
      Effect.sync(() => { legacyReads++; return ok("older"); })).pipe(Effect.provideService(CommandRunner, {
      run: ({ argv: [ssh, host, script] }) => Effect.promise(async () => {
        if (ssh !== "ssh" || host !== "example" || !script) throw new Error("Unexpected transport");
        const body = installed ? `[ "$*" = "report ${report}" ] && printf 'compact\\n'` : "return 1";
        const peer = Bun.spawn(["bash", "-c", `orc-dash() { ${body}; }; ${script}`], { stdout: "pipe" });
        const stdout = await new Response(peer.stdout).text();
        if (await peer.exited !== 0) throw new Error("Unexpected peer exit");
        return stdout;
      }),
    })));
    return { result, legacyReads };
  };

  test(`a peer supporting ${report} does not transfer the legacy reading`, async () => {
    expect(await withPeer(true)).toEqual({ result: ok("compact"), legacyReads: 0 });
  });
  test(`an older peer without ${report} reads the configured legacy command once`, async () => {
    expect(await withPeer(false)).toEqual({ result: ok("older"), legacyReads: 1 });
  });
}

test("a custom quota transport is not rewritten as an ssh command", () => {
  expect(peerReport("subscriptions", "my-quota-proxy --local")).toBeUndefined();
});
