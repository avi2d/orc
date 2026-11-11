import { type Config, Context, Duration, Layer } from "effect";
import type { CommandRunner } from "../shared/lib";
import { decodeResourcesReport } from "./resources";
import type { ReportedResources } from "./resources";
import { configuredMachines, type Machines } from "../shared/config";

export class ResourceMachines extends Context.Service<ResourceMachines, Machines<ReportedResources>>()(
  "orc-dash/ResourceMachines",
) {}

// The other machine samples its cpu over a second, so it answers in a few seconds, and a hung answer holds a paint no longer than this.
const remoteTimeout = Duration.seconds(15);

export const resourceMachinesLayer: Layer.Layer<ResourceMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  ResourceMachines,
  configuredMachines("ORC_DASH_REMOTE_RESOURCES", remoteTimeout, () => decodeResourcesReport),
);
