import { type Config, Context, Duration, Layer } from "effect";
import type { CommandRunner } from "../command";
import { type Decoded, decodeJson, flatMapDecoded } from "../decode";
import { SessionQuotaReport } from "../contract/session-quota";
import { sessionQuotaViewOf } from "../contract/session-quota-view";
import type { SessionQuotaView } from "../views/session-quota";
import { configuredMachines, type Machines, type RemoteSource } from "./machines";

export type RemoteSessionSource = RemoteSource<SessionQuotaView>;

export class SessionMachines extends Context.Service<SessionMachines, Machines<SessionQuotaView>>()("tui-dash/SessionMachines") {}

const remoteTimeout = Duration.seconds(90);

export const decodeRemoteSessionQuota =
  (machine: string) =>
  (stdout: string): Decoded<SessionQuotaView> =>
    flatMapDecoded(decodeJson(SessionQuotaReport)(stdout), (report) => sessionQuotaViewOf(report, machine));

export const sessionMachinesLayer: Layer.Layer<SessionMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  SessionMachines,
  configuredMachines("TUI_DASH_REMOTE_SESSION_QUOTA", remoteTimeout, decodeRemoteSessionQuota),
);
