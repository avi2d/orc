import { DateTime, Effect, Layer } from "effect";
import type { Reading } from "../reading";
import { composedSessionQuota } from "../views/composed-session-quota";
import { sessionLogsSince, sessionQuotaFrom, type SessionQuotaView } from "../views/session-quota";
import { SavedProfilesSource, savedProfilesSourceLayer, type SavedProfiles } from "./saved-profiles";
import { HarnessProcessSource, HerdrSource, herdrSourceLayer, linuxHarnessProcessSourceLayer, macHarnessProcessSourceLayer } from "./live-sessions";
import { readBeside } from "./machines";
import { type QuotaSource, quotaSourceLayer } from "./quota";
import { type QuotaRead, readQuota } from "./quota-read";
import { SessionMachines, sessionMachinesLayer } from "./remote-sessions";
import { type HarvestLogSource, harvestLogSourceLayer, SessionLogSource, sessionLogSourceLayer } from "./session-logs";

export type SessionSources = HerdrSource | HarnessProcessSource | SessionLogSource | SessionMachines;

export type QuotaReadSources = QuotaSource | HarvestLogSource | SavedProfilesSource;

export type SessionQuotaSources = QuotaReadSources | SessionSources;

export interface QuotaReadings {
  readonly quota: QuotaRead;
  readonly savedProfiles: Reading<SavedProfiles>;
}

const harnessProcessSourceLayer = process.platform === "darwin" ? macHarnessProcessSourceLayer : linuxHarnessProcessSourceLayer;

export const sessionSourcesLayer = Layer.mergeAll(herdrSourceLayer, harnessProcessSourceLayer, sessionMachinesLayer, sessionLogSourceLayer);

export const quotaReadSourcesLayer = Layer.mergeAll(quotaSourceLayer, savedProfilesSourceLayer, harvestLogSourceLayer(Effect.succeed([])));

export const sessionQuotaSourcesLayer = Layer.merge(quotaReadSourcesLayer, sessionSourcesLayer);

export const localSessionQuotaOf = <R>(quotas: Effect.Effect<QuotaReadings, never, R>): Effect.Effect<SessionQuotaView, never, Exclude<SessionSources, SessionMachines> | R> =>
  Effect.gen(function* () {
    const herdr = yield* HerdrSource;
    const harnesses = yield* HarnessProcessSource;
    const logSource = yield* SessionLogSource;
    const timeZone = DateTime.zoneMakeLocal();
    const logged = Effect.gen(function* () {
      const readings = yield* quotas;
      const logs = yield* logSource.read(sessionLogsSince(readings.quota, yield* DateTime.now, timeZone));
      return { ...readings, logs };
    });
    const [panes, processes, { quota, savedProfiles, logs }] = yield* Effect.all([herdr.read, harnesses.read, logged], { concurrency: "unbounded" });
    return sessionQuotaFrom({ quota, savedProfiles, panes, processes, logs, now: yield* DateTime.now, timeZone });
  });

export const composedSessionQuotaOf = <R>(quotas: Effect.Effect<QuotaReadings, never, R>): Effect.Effect<SessionQuotaView, never, SessionSources | R> =>
  Effect.gen(function* () {
    const machines = yield* SessionMachines;
    const [local, remotes] = yield* readBeside(localSessionQuotaOf(quotas), machines);
    return composedSessionQuota(local, machines.local, remotes);
  });

export const sessionQuotaOf = <R>(quotas: Effect.Effect<QuotaReadings, never, R>): Effect.Effect<SessionQuotaView, never, SessionSources | R> =>
  Effect.flatMap(SessionMachines, (machines) =>
    machines.remotes.length === 0 ? localSessionQuotaOf(quotas) : composedSessionQuotaOf(quotas),
  );

export const readQuotas: Effect.Effect<QuotaReadings, never, QuotaReadSources> = Effect.flatMap(SavedProfilesSource, (savedProfiles) =>
  Effect.all({ quota: readQuota, savedProfiles: savedProfiles.read }, { concurrency: "unbounded" }),
);
