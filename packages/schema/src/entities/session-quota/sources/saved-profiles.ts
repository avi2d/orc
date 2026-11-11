import { type Config, Context, Duration, Effect, Layer, Schema } from "effect";
import type { CommandRunner } from "../../../shared/lib";
import { type Decoded, decodeJson } from "../../../shared/lib";
import { ok } from "../../../shared/lib";
import { runDecoded, sourceOf, stamped, type Source } from "../../../shared/lib";
import { selector } from "../../../shared/config";

const Instant = Schema.DateTimeUtcFromString;

const SavedWindow = Schema.Struct({
  label: Schema.String,
  utilization_pct: Schema.Finite,
  resets_at: Schema.NullOr(Instant),
});

const Profile = Schema.Struct({
  name: Schema.String,
  active: Schema.Boolean,
  provider: Schema.String,
  harness: Schema.String,
  tier: Schema.NullOr(Schema.String),
  stale: Schema.Boolean,
  fetched_at: Schema.NullOr(Instant),
  windows: Schema.Array(SavedWindow),
});

const SavedProfiles = Schema.Struct({
  schema: Schema.Literal(2),
  active_profile: Schema.NullOr(Schema.String),
  profiles: Schema.Array(Profile),
});

export type SavedProfiles = typeof SavedProfiles.Type;
export type SavedProfile = typeof Profile.Type;

export const decodeSavedProfiles: (stdout: string) => Decoded<SavedProfiles> = decodeJson(SavedProfiles);

const savedProfilesTimeout = Duration.seconds(10);

const noSavedProfiles: SavedProfiles = { schema: 2, active_profile: null, profiles: [] };

export class SavedProfilesSource extends Context.Service<SavedProfilesSource, Source<SavedProfiles>>()("orc-dash/SavedProfilesSource") {}

// The configured command is a shell line, so the shell parses its quoting.
export const savedProfilesSourceLayer: Layer.Layer<SavedProfilesSource, Config.ConfigError, CommandRunner> = Layer.effect(
  SavedProfilesSource,
  Effect.gen(function* () {
    const command = yield* selector("ORC_DASH_SAVED_PROFILES");
    if (command === undefined) return { read: stamped(Effect.succeed(ok(noSavedProfiles))) };
    return yield* sourceOf(stamped(runDecoded({ argv: ["sh", "-c", command], timeout: savedProfilesTimeout }, decodeSavedProfiles)));
  }),
);
