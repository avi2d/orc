import { DateTime, Effect, Layer } from "effect";
import { composedSessionQuota } from "./composed-session-quota";
import { sessionLogsSince, sessionQuotaFrom, type SessionQuotaView } from "./session-quota";
import { HarnessProcessSource, HerdrSource, herdrSourceLayer, linuxHarnessProcessSourceLayer, macHarnessProcessSourceLayer } from "../sources/live-sessions";
import { readBeside } from "../../../shared/config";
import type { QuotaReadSources, QuotaReadings } from "../sources/quota-read";
import { SessionMachines, sessionMachinesLayer } from "./remote-sessions";
import { SessionLogSource, sessionLogSourceLayer } from "../sources/session-logs";

export type SessionSources = HerdrSource | HarnessProcessSource | SessionLogSource | SessionMachines;

export type SessionQuotaSources = QuotaReadSources | SessionSources;

const harnessProcessSourceLayer = process.platform === "darwin" ? macHarnessProcessSourceLayer : linuxHarnessProcessSourceLayer;

export const sessionSourcesLayer = Layer.mergeAll(herdrSourceLayer, harnessProcessSourceLayer, sessionMachinesLayer, sessionLogSourceLayer);

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
    const [panes, processes, readings] = yield* Effect.all([herdr.read, harnesses.read, logged], { concurrency: "unbounded" });
    return sessionQuotaFrom({ ...readings, panes, processes, now: yield* DateTime.now, timeZone });
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
