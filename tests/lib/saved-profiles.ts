import { ConfigProvider, Layer } from "effect";
import { type Command, savedProfilesSourceLayer } from "@tui-dash/schema";

const savedProfilesCommand = "saved-profiles --json";

export const isSavedProfilesCall = (command: Command): boolean => command.argv[0] === "sh" && command.argv[2] === savedProfilesCommand;

export const recordedSavedProfilesLayer = savedProfilesSourceLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_SAVED_PROFILES: savedProfilesCommand }))),
);
