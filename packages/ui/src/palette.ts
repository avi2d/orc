import { Context } from "effect";

export type Rgb = readonly [number, number, number];

// The hex is #rrggbb.
export const rgbOfHex = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

export const themeTones = ["primary", "accent", "warning", "error", "success", "foreground", "muted", "subtle", "faint", "focus", "pick", "held"] as const;

export type ThemeTone = (typeof themeTones)[number];

const themeHexes: Readonly<Record<ThemeTone, string>> = {
  primary: "#60aaf3",
  accent: "#66cfe1",
  warning: "#e3b667",
  error: "#ed7473",
  success: "#68ca80",
  foreground: "#d3d8e1",
  muted: "#969aa3",
  subtle: "#adb1ba",
  faint: "#5c6370",
  focus: "#8cc4ff",
  pick: "#2d4f7c",
  held: "#2c323d",
};

export const tintedProviders = ["claude", "codex", "opencode-go"] as const;

export type TintedProvider = (typeof tintedProviders)[number];

const providerHexes: Readonly<Record<TintedProvider, string>> = {
  claude: "#d97757",
  codex: "#60aaf3",
  "opencode-go": "#66cfe1",
};

export type QuotaTint = "claude" | "codex" | "opencodeGo";

export const tintOfProvider = (provider: string): QuotaTint => {
  if (provider === "codex") return "codex";
  if (provider === "opencode-go") return "opencodeGo";
  return "claude";
};

export type Tone = ThemeTone | QuotaTint;

export interface Theme {
  readonly tones: Readonly<Record<Tone, Rgb>>;
}

export interface ThemeHexes {
  readonly tones?: Partial<Readonly<Record<ThemeTone, string>>>;
  readonly providers?: Partial<Readonly<Record<TintedProvider, string>>>;
}

// Every hex in the overrides is #rrggbb.
export const themeOf = (overrides: ThemeHexes): Theme => {
  const tone = (name: ThemeTone): Rgb => rgbOfHex(overrides.tones?.[name] ?? themeHexes[name]);
  const tint = (provider: TintedProvider): Rgb => rgbOfHex(overrides.providers?.[provider] ?? providerHexes[provider]);
  return {
    tones: {
      primary: tone("primary"),
      accent: tone("accent"),
      warning: tone("warning"),
      error: tone("error"),
      success: tone("success"),
      foreground: tone("foreground"),
      muted: tone("muted"),
      subtle: tone("subtle"),
      faint: tone("faint"),
      focus: tone("focus"),
      pick: tone("pick"),
      held: tone("held"),
      claude: tint("claude"),
      codex: tint("codex"),
      opencodeGo: tint("opencode-go"),
    },
  };
};

export const defaultTheme: Theme = themeOf({});

// Panels name tones and only the painter reads this, so a theme recolours every panel without one of them changing.
export const Appearance = Context.Reference<Theme>("@tui-dash/ui/Appearance", { defaultValue: () => defaultTheme });

export const rgbOfTone = (tone: Tone, theme: Theme = defaultTheme): Rgb => theme.tones[tone];
