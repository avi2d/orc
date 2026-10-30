import { type Config, Data, type Duration, Effect, Result, Schema, type Scope } from "effect";
import { type Freshness, strictly } from "@tui-dash/schema";
import type { Block } from "./layout";
import type { Drawn, Move, ScreenSize } from "./screen";
import type { Line } from "./text";

export interface Look {
  readonly focused: boolean;
  // Set when the host titles the box itself, such as with a row of tabs.
  readonly title: Line | undefined;
  // Lines the shut tabs leave at the foot of the open one, inside its frame.
  readonly below: Block;
  // The box has the screen to itself, so a module with a fuller form draws that.
  readonly alone: boolean;
}

// One module's view state, closed over so the host holds every module's state without knowing its type.
export interface Placed {
  readonly box: (size: ScreenSize, look: Look) => Drawn<Placed>;
  // Rows the box wants at this width, its frame included.
  readonly natural: (width: number) => number;
  readonly least: (width: number) => number;
  // Columns the box fills while focused in a row this wide; a focused box whose cell is narrower grows to it.
  readonly fullWidth?: (row: number) => number;
  // Unframed sections for a stack of glances, from the fullest to the shortest.
  readonly glance: (width: number) => ReadonlyArray<Block>;
  // The line the box leaves under another tab while its own tab is shut.
  readonly badge?: (width: number) => Line;
  // Undefined hands the focus back to the host.
  readonly move?: (move: Move, size: ScreenSize) => Placed | undefined;
  readonly press?: (key: string, size: ScreenSize) => Placed;
  readonly blur?: () => Placed;
  // Defined while the box takes the whole screen, such as an open reader.
  readonly whole?: (size: ScreenSize) => Drawn<Placed> | undefined;
  readonly link?: (size: ScreenSize) => string | undefined;
}

// moves: the arrows and enter reach it from the home focus. key: only its hotkey or a click focuses it.
export type FocusReach = "moves" | "key" | "none";

export interface Mounted {
  readonly name: string;
  readonly key: string | undefined;
  readonly cadence: Duration.Input;
  readonly reach: FocusReach;
  // Reads once more, and every draw until the next one shows what it read.
  readonly refresh: Effect.Effect<void>;
  // True while a source has yet to answer, so the host paints again soon.
  readonly pending: () => boolean;
  // True while a refresh runs, so the host shows reading only while it refreshes.
  readonly refreshing: () => boolean;
  readonly freshness: () => ReadonlyArray<Freshness>;
  readonly start: Placed;
}

export interface PrintFrame {
  readonly width: number;
  readonly height: number;
  readonly color: boolean;
}

// The section is where the settings sit in the config file, such as panels.quota; only the caller knows which file that is.
export class SettingsRefused extends Data.TaggedError("SettingsRefused")<{ readonly section: string; readonly issue: string }> {
  inFile(path: string | undefined): string {
    return `${this.section}${path === undefined ? "" : ` in ${path}`} is not valid: ${this.issue}`;
  }

  get reason(): string {
    return this.inFile(undefined);
  }
}

export type PanelError = SettingsRefused | Config.ConfigError;

export interface PanelModule<R> {
  readonly id: string;
  readonly about: string;
  // The settings are the module's own section of the config file, decoded inside the module and nowhere else.
  readonly mount: (settings: unknown) => Effect.Effect<Mounted, PanelError, R | Scope.Scope>;
  readonly run: (settings: unknown) => Effect.Effect<void, PanelError, R>;
  readonly print: (settings: unknown, frame: PrintFrame) => Effect.Effect<void, PanelError, R>;
}

export interface ModuleSpec<S, R> {
  readonly id: string;
  readonly about: string;
  readonly settings: Schema.Decoder<S>;
  readonly mount: (settings: S) => Effect.Effect<Mounted, PanelError, R | Scope.Scope>;
  readonly run: (settings: S) => Effect.Effect<void, PanelError, R>;
  readonly print: (settings: S, frame: PrintFrame) => Effect.Effect<void, PanelError, R>;
}

export const decodeSettings = <S>(section: string, settings: Schema.Decoder<S>, raw: unknown): Effect.Effect<S, SettingsRefused> => {
  const decoded = Schema.decodeResult(settings)(raw === undefined ? {} : raw, strictly);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(new SettingsRefused({ section, issue: decoded.failure.message }));
};

export const panelModule = <S, R>(spec: ModuleSpec<S, R>): PanelModule<R> => {
  const settingsOf = (raw: unknown) => decodeSettings(`panels.${spec.id}`, spec.settings, raw);
  return {
    id: spec.id,
    about: spec.about,
    mount: (raw) => Effect.flatMap(settingsOf(raw), spec.mount),
    run: (raw) => Effect.flatMap(settingsOf(raw), spec.run),
    print: (raw, frame) => Effect.flatMap(settingsOf(raw), (settings) => spec.print(settings, frame)),
  };
};

// An empty Struct takes any value at all, so a misspelt key under a panel with no settings would pass unread.
export const noSettings = Schema.Record(Schema.String, Schema.Never.annotate({ message: "this panel takes no settings" }));

export type NoSettings = typeof noSettings.Type;

export interface MountSpec<A, R> {
  readonly name: string;
  readonly key?: string;
  readonly cadence: Duration.Input;
  readonly reach: FocusReach;
  readonly read: Effect.Effect<A, never, R>;
  readonly pending: (reading: A) => boolean;
  readonly refreshing: (reading: A) => boolean;
  readonly freshness: (reading: A) => ReadonlyArray<Freshness>;
  // The reading is asked for on every draw, so the view never holds one the next refresh replaced.
  readonly placed: (reading: () => A) => Placed;
}

export const mountedOf = <A, R>(spec: MountSpec<A, R>): Effect.Effect<Mounted, never, R> =>
  Effect.gen(function* () {
    let latest = yield* spec.read;
    const services = yield* Effect.context<R>();
    return {
      name: spec.name,
      key: spec.key,
      cadence: spec.cadence,
      reach: spec.reach,
      refresh: Effect.provideContext(spec.read, services).pipe(
        Effect.map((reading) => {
          latest = reading;
        }),
      ),
      pending: () => spec.pending(latest),
      refreshing: () => spec.refreshing(latest),
      freshness: () => spec.freshness(latest),
      start: spec.placed(() => latest),
    };
  });
