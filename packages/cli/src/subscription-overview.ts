import { Duration, Effect } from "effect";
import { decodeJson, mapOutcome, readSubscriptions, selector, SessionMachines, SubscriptionReport, subscriptionOverview, subscriptionReport } from "@avi2dg/orc-schema";
import { peerReport, preferPeerReport } from "./peer-report";

export const subscriptionOverviewDocument = (...[local, remotes]: Parameters<typeof subscriptionOverview>): {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sources: { readonly quota: { readonly status: "ok"; readonly report: ReturnType<typeof subscriptionOverview> } };
} => ({
  schemaVersion: 1,
  generatedAt: new Date(local.readAt).toISOString(),
  sources: { quota: { status: "ok", report: subscriptionOverview(local, remotes) } },
});

export const readSubscriptionOverview = Effect.gen(function* () {
  const machines = yield* SessionMachines;
  const command = yield* selector("ORC_DASH_REMOTE_SESSION_QUOTA");
  const peers = Effect.forEach(machines.remotes, (machine) => {
    const legacy = Effect.map(machine.read, (reading) => mapOutcome(reading, (view) => subscriptionReport(view.accounts, view.now)));
    return Effect.map(preferPeerReport(peerReport("subscriptions", command), Duration.seconds(90), decodeJson(SubscriptionReport), legacy),
      (reading) => ({ name: machine.name, reading }));
  }, { concurrency: "unbounded" });
  const [local, remotes] = yield* Effect.all([readSubscriptions, peers], { concurrency: "unbounded" });
  return subscriptionOverviewDocument(local, remotes);
});
