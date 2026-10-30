import { type CliRenderer, createCliRenderer, type KeyEvent, type MouseEvent, TextRenderable } from "@opentui/core";
import { Console, Deferred, Effect, Schedule } from "effect";
import type { Block } from "./layout";
import { blockDocument, frameAnsi, frameText } from "./opentui";
import { Appearance } from "./palette";

export interface Target<S> {
  readonly row: number;
  readonly from: number;
  readonly to: number;
  readonly state: S;
}

export interface Drawn<S> {
  readonly block: Block;
  readonly targets: ReadonlyArray<Target<S>>;
}

export type Move = "up" | "down" | "in" | "out" | "pageup" | "pagedown";

export interface ScreenSize {
  readonly columns: number;
  readonly rows: number;
}

export interface Screen<A, S, R> {
  readonly read: Effect.Effect<A, never, R>;
  readonly initial: S;
  readonly draw: (value: A, state: S, columns: number, rows: number) => Drawn<S>;
  // The size lets a screen whose layout changes with it move only through what the layout shows.
  readonly move: (value: A, state: S, move: Move, size: ScreenSize) => S;
  // A named key the moves above do not cover, such as a letter opening its own box.
  readonly press?: (value: A, state: S, key: string, size: ScreenSize) => S;
  // The live screen runs this when the terminal resizes, so a state the new size has no room for does not linger.
  readonly resized?: (value: A, state: S, size: ScreenSize) => S;
  // The address the open detail points at; enter opens it while the moves above only move.
  readonly link?: (value: A, state: S, size: ScreenSize) => string | undefined;
  readonly pending?: (value: A) => boolean;
}

const moves: ReadonlyMap<string, Move> = new Map([
  ["up", "up"],
  ["down", "down"],
  ["pageup", "pageup"],
  ["pagedown", "pagedown"],
  ["return", "in"],
  ["enter", "in"],
  ["right", "in"],
  ["escape", "out"],
  ["left", "out"],
]);

const leftButton = 0;

const pendingFloor = "250 millis";

const goneCodes: ReadonlySet<string> = new Set(["EIO", "EPIPE"]);

const streamGone = (error: Error): boolean => "code" in error && typeof error.code === "string" && goneCodes.has(error.code);

export const targetAt = <S>(targets: ReadonlyArray<Target<S>>, x: number, y: number): Target<S> | undefined =>
  targets.find((target) => target.row === y && target.from <= x && x < target.to);

// The opener runs detached, so quitting still owns the terminal while the link opens beside it.
const openAddress = (address: string): void => {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (!Bun.which(opener)) return;
  Bun.spawn([opener, address], { detached: true, stdio: ["ignore", "ignore", "ignore"] }).unref();
};

export const liveScreen = <A, S, R>(
  renderer: CliRenderer,
  screen: Screen<A, S, R>,
  refresh: Parameters<typeof Schedule.spaced>[0],
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const quit = yield* Deferred.make<void>();
    const services = yield* Effect.context<R>();
    const theme = yield* Appearance;
    let latest: A | undefined;
    let state = screen.initial;
    let drawn: Drawn<S> | undefined;
    const text = new TextRenderable(renderer, { content: "", wrapMode: "none" });
    const draw = () => {
      if (latest === undefined) return;
      drawn = screen.draw(latest, state, renderer.terminalWidth, renderer.terminalHeight);
      text.content = blockDocument(drawn.block, theme);
    };
    const moveTo = (next: S) => {
      if (next === state) return;
      state = next;
      draw();
    };
    const leave = (): void => {
      Effect.runForkWith(services)(Deferred.succeed(quit, undefined));
    };
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "q" || (key.name === "c" && key.ctrl)) {
        leave();
        return;
      }
      if (latest === undefined) return;
      const move = moves.get(key.name);
      if (move !== undefined) {
        if (move === "in" && (key.name === "enter" || key.name === "return") && screen.link !== undefined) {
          const address = screen.link(latest, state, { columns: renderer.terminalWidth, rows: renderer.terminalHeight });
          if (address !== undefined) openAddress(address);
        }
        moveTo(screen.move(latest, state, move, { columns: renderer.terminalWidth, rows: renderer.terminalHeight }));
        return;
      }
      if (screen.press !== undefined && !key.ctrl && !key.meta && key.name.length === 1) {
        moveTo(screen.press(latest, state, key.name.toLowerCase(), { columns: renderer.terminalWidth, rows: renderer.terminalHeight }));
      }
    });
    text.onMouseDown = (event: MouseEvent) => {
      if (event.button !== leftButton || drawn === undefined) return;
      const target = targetAt(drawn.targets, event.x, event.y);
      if (target !== undefined) moveTo(target.state);
    };
    renderer.root.add(text);
    renderer.on("resize", () => {
      if (latest !== undefined && screen.resized !== undefined) {
        state = screen.resized(latest, state, { columns: renderer.terminalWidth, rows: renderer.terminalHeight });
      }
      draw();
    });
    // Losing the tty quits through the same gate as q so the scope finalizers stop the spawned readers.
    renderer.stdin.once("close", leave);
    renderer.stdin.once("end", leave);
    const onStreamError = (error: Error): void => {
      if (streamGone(error)) leave();
    };
    renderer.stdin.on("error", onStreamError);
    process.stdout.on("error", onStreamError);
    const unwatch = (): void => {
      renderer.stdin.removeListener("close", leave);
      renderer.stdin.removeListener("end", leave);
      renderer.stdin.removeListener("error", onStreamError);
      process.stdout.removeListener("error", onStreamError);
    };
    const paint = screen.read.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          latest = value;
          draw();
        }),
      ),
    );
    // A read served from a value that landed moments ago returns at once, so without a floor a pending screen would spin.
    const settled = paint.pipe(Effect.repeat({ while: (value) => screen.pending?.(value) ?? false, schedule: Schedule.spaced(pendingFloor) }));
    const reread = settled.pipe(Effect.andThen(paint.pipe(Effect.delay(refresh), Effect.forever)));
    yield* Effect.raceAll([reread, Deferred.await(quit), Effect.promise(() => renderer.closed)]).pipe(
      Effect.ensuring(Effect.sync(unwatch)),
    );
  });

export const runScreen = <A, S, R>(screen: Screen<A, S, R>, refresh: Parameters<typeof Schedule.spaced>[0]): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const renderer = yield* Effect.promise(() => createCliRenderer());
    yield* liveScreen(renderer, screen, refresh).pipe(Effect.ensuring(Effect.sync(() => renderer.destroy())));
  });

export const printScreen = <A, S, R>(screen: Screen<A, S, R>, width: number, height: number, color = false): Effect.Effect<void, never, R> =>
  Effect.flatMap(screen.read, (value) => printBlock(screen.draw(value, screen.initial, width, height).block, width, color));

export const printBlock = (rows: Block, width: number, color: boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const document = blockDocument(rows, yield* Appearance);
    const frame = yield* color ? frameAnsi(document, width, rows.length + 1) : frameText(document, width, rows.length + 1);
    yield* Console.log(frame);
  });
