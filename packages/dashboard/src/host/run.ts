import { Clock, Effect, type Scope } from "effect";
import { type DashConfig, loopTick, ReadModeReference } from "@tui-dash/schema";
import { type Mounted, type PanelError, type PanelModule, panelWidth, printBlock, type PrintFrame, runScreen, type Screen } from "@tui-dash/ui";
import { boardOf, type Member } from "./board";
import { decodeLayout, layoutPanels } from "./layout";
import { hostScreen, type HostState } from "./screen";

// Only the panels the layout names are mounted, so a panel left out of it reads nothing.
export const dashboardScreen = <R>(modules: ReadonlyArray<PanelModule<R>>, config: DashConfig): Effect.Effect<Screen<number, HostState, never>, PanelError, R | Scope.Scope> =>
  Effect.gen(function* () {
    const layout = yield* decodeLayout(config.layout, modules.map((module) => module.id));
    const named = layoutPanels(layout);
    const members = yield* Effect.forEach(
      named.flatMap((id) => modules.filter((module) => module.id === id)),
      (module): Effect.Effect<Member, PanelError, R | Scope.Scope> => Effect.map(module.mount(config.panels[module.id]), (mounted) => ({ id: module.id, mounted })),
      { concurrency: "unbounded" },
    );
    const mounted = new Map<string, Mounted>(members.map((member) => [member.id, member.mounted]));
    const live = (yield* ReadModeReference) === "live";
    return hostScreen(boardOf(layout, mounted), members, live);
  });

export const runDashboard = <R>(modules: ReadonlyArray<PanelModule<R>>, config: DashConfig): Effect.Effect<void, PanelError, R> =>
  Effect.scoped(Effect.flatMap(dashboardScreen(modules, config), (screen) => runScreen(screen, loopTick)));

// Each module read once as it mounted, so in the print read mode the frame draws what they read without reading again.
export const printDashboard = <R>(modules: ReadonlyArray<PanelModule<R>>, config: DashConfig, frame: PrintFrame): Effect.Effect<void, PanelError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const screen = yield* dashboardScreen(modules, config);
      const now = yield* Clock.currentTimeMillis;
      yield* printBlock(screen.draw(now, screen.initial, frame.width, frame.height).block, panelWidth(frame.width), frame.color);
    }),
  );
