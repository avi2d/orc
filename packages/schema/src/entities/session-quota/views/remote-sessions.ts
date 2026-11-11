import { type Config, Context, Duration, Layer } from "effect";
import type { CommandRunner } from "../../../shared/lib";
import { type Decoded, decodeJson, flatMapDecoded } from "../../../shared/lib";
import { SessionQuotaReport } from "../contract/session-quota";
import { sessionQuotaViewOf } from "./session-quota-view";
import type { SessionQuotaView } from "./session-quota";
import { configuredMachines, type Machines, type RemoteSource } from "../../../shared/config";

export type RemoteSessionSource = RemoteSource<SessionQuotaView>;

export class SessionMachines extends Context.Service<SessionMachines, Machines<SessionQuotaView>>()("orc-dash/SessionMachines") {}

const remoteTimeout = Duration.seconds(90);

export const decodeRemoteSessionQuota =
  (machine: string) =>
  (stdout: string): Decoded<SessionQuotaView> =>
    flatMapDecoded(decodeJson(SessionQuotaReport)(stdout), (report) => sessionQuotaViewOf(report, machine));

export const sessionMachinesLayer: Layer.Layer<SessionMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  SessionMachines,
  configuredMachines("ORC_DASH_REMOTE_SESSION_QUOTA", remoteTimeout, decodeRemoteSessionQuota),
);
