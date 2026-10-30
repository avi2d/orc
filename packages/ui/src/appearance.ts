import { Effect, Schema } from "effect";
import { decodeSettings, type SettingsRefused } from "./module";
import { type Theme, type ThemeHexes, themeOf } from "./palette";

const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u));

const optionalHex = Schema.optionalKey(Hex);

const AppearanceSettings = Schema.Struct({
  tones: Schema.optionalKey(
    Schema.Struct({
      primary: optionalHex,
      accent: optionalHex,
      warning: optionalHex,
      error: optionalHex,
      success: optionalHex,
      foreground: optionalHex,
      muted: optionalHex,
      subtle: optionalHex,
      faint: optionalHex,
      focus: optionalHex,
      pick: optionalHex,
      held: optionalHex,
    }),
  ),
  providers: Schema.optionalKey(Schema.Struct({ claude: optionalHex, codex: optionalHex, "opencode-go": optionalHex })),
});

const hexes: Schema.Decoder<ThemeHexes> = AppearanceSettings;

export const themeOfSettings = (raw: unknown): Effect.Effect<Theme, SettingsRefused> => Effect.map(decodeSettings("appearance", hexes, raw), themeOf);
