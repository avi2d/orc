import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { boardOf, decodeLayout, type HostState, hostScreen, layoutPanels } from "@tui-dash/dashboard";
import { type Block, type FocusReach, type Look, type Mounted, type Move, type Placed, plain, type ScreenSize, span, targetAt, truncate } from "@tui-dash/ui";
import { membersOf } from "../../lib/host-fixture";

interface Count {
  readonly name: string;
  readonly at: number;
  readonly blurs: number;
  readonly pressed: string;
}

const textOf = (count: Count, look: Look): string =>
  `${look.focused ? "*" : " "}${look.title === undefined ? count.name : plain(look.title)} at=${count.at} blurs=${count.blurs} pressed=${count.pressed}`;

// Down counts up, up counts down and hands the focus back from zero, and out always hands it back.
const counter = (count: Count): Placed => ({
  box: (size, look) => {
    const line = textOf(count, { ...look, title: undefined });
    const head: Block = look.title === undefined ? [] : [truncate(look.title, size.columns)];
    return { block: [...head, [span(line.slice(0, size.columns), "foreground")]], targets: [] };
  },
  natural: () => 1,
  least: () => 1,
  glance: () => [[[span(`${count.name} at=${count.at}`, "foreground")]]],
  move: (move: Move) => {
    if (move === "down") return counter({ ...count, at: count.at + 1 });
    if (move === "up" && count.at > 0) return counter({ ...count, at: count.at - 1 });
    return undefined;
  },
  press: (key) => counter({ ...count, pressed: count.pressed + key }),
  blur: () => counter({ ...count, blurs: count.blurs + 1 }),
});

const fake = (name: string, reach: FocusReach, key?: string): Mounted => ({
  name,
  key,
  cadence: "1 second",
  reach,
  refresh: Effect.void,
  pending: () => false,
  refreshing: () => false,
  freshness: () => [],
  start: counter({ name, at: 0, blurs: 0, pressed: "" }),
});

const mounted: ReadonlyMap<string, Mounted> = new Map([
  ["mover", fake("mover", "moves")],
  ["keyed", fake("keyed", "key", "k")],
  ["shown", fake("shown", "none", "s")],
  ["wide-only", fake("wide-only", "key", "w")],
]);

const layout = {
  wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", cells: [{ panel: "mover" }, { tabs: ["keyed", "shown"] }, { panel: "wide-only" }] }] }],
  narrow: ["mover", "keyed", "shown"],
};

const wide: ScreenSize = { columns: 180, rows: 6 };

const narrow: ScreenSize = { columns: 60, rows: 6 };

type Step = { readonly move: Move } | { readonly press: string };

const screenAt = async () => {
  const decoded = await Effect.runPromise(decodeLayout(layout, [...mounted.keys()]));
  return hostScreen(boardOf(decoded, mounted), membersOf(mounted, layoutPanels(decoded)));
};

const after = async (size: ScreenSize, steps: ReadonlyArray<Step>): Promise<{ readonly state: HostState; readonly frame: string }> => {
  const screen = await screenAt();
  const state = steps.reduce((held, step) => ("move" in step ? screen.move(0, held, step.move, size) : (screen.press?.(0, held, step.press, size) ?? held)), screen.initial);
  return { state, frame: screen.draw(0, state, size.columns, size.rows).block.map(plain).join("\n") };
};

// The rules are the dashboard's focus rules as the design settled them: home is the first panel the arrows reach, a panel's key opens its tab and focuses it only when it takes the focus, and the panel focus leaves is told so.
describe("the host passes the focus between panels it knows only by their module", () => {
  test("at home the arrows step the home panel without focusing it", async () => {
    const { state, frame } = await after(wide, [{ move: "down" }, { move: "down" }]);
    expect(state.focus).toBeUndefined();
    expect(frame).toContain("*mover at=2 blurs=0 pressed= ");
  });

  test("out at home changes nothing", async () => {
    const screen = await screenAt();
    expect(screen.move(0, screen.initial, "out", wide)).toBe(screen.initial);
  });

  test("in focuses the home panel and the arrows go on reaching it", async () => {
    const { state, frame } = await after(wide, [{ move: "in" }, { move: "down" }]);
    expect(state.focus).toBe("mover");
    expect(frame).toContain("mover at=1");
  });

  test("a panel handing the focus back is blurred and home takes the arrows again", async () => {
    const { state, frame } = await after(wide, [{ move: "in" }, { move: "up" }]);
    expect(state.focus).toBeUndefined();
    expect(frame).toContain("mover at=0 blurs=1");
  });

  test("a panel's key opens its tab and focuses it, blurring the panel that had the focus", async () => {
    const { state, frame } = await after(wide, [{ move: "in" }, { press: "k" }]);
    expect(state.focus).toBe("keyed");
    expect(frame).toContain("mover at=0 blurs=1");
    expect(frame).toMatch(/\*keyed.*at=0 blurs=0 pressed=k/u);
  });

  test("the key of a panel the focus cannot reach only opens its tab", async () => {
    const { state, frame } = await after(wide, [{ press: "s" }]);
    expect(state.focus).toBeUndefined();
    expect(state.open.get("keyed|shown")).toBe("shown");
    expect(frame).toMatch(/shown.*pressed= /u);
  });

  test("cycling the focused tab blurs the panel it hides", async () => {
    const { state, frame } = await after(wide, [{ move: "in" }, { press: "k" }, { press: "]" }]);
    expect(state.open.get("keyed|shown")).toBe("shown");
    expect(state.focus).toBeUndefined();
    expect(frame).toContain("shown at=0");
    const reopened = await after(wide, [{ move: "in" }, { press: "k" }, { press: "]" }, { press: "k" }]);
    expect(reopened.state.focus).toBe("keyed");
    expect(reopened.frame).toMatch(/\*keyed.*at=0 blurs=1 pressed=kk/u);
  });

  test("the shut tab title opens its tab with no hidden focus", async () => {
    const screen = await screenAt();
    const held = screen.press?.(0, screen.initial, "k", wide) ?? screen.initial;
    expect(held.focus).toBe("keyed");
    const drawn = screen.draw(0, held, wide.columns, wide.rows);
    const shut = drawn.targets.find((target) => target.row === 0 && target.state.open.get("keyed|shown") === "shown");
    expect(shut).toBeDefined();
    if (shut === undefined) throw new Error("no shut tab target");
    expect(shut.state.open.get("keyed|shown")).toBe("shown");
    expect(shut.state.focus).toBeUndefined();
    const frame = screen.draw(0, shut.state, wide.columns, wide.rows).block.map(plain).join("\n");
    expect(frame).toContain("shown at=0");
  });

  test("a click on the cadence opens no hidden tab", async () => {
    const truncated = new Map([
      ["quota", fake("quota", "key", "q")],
      ["alerts", fake("alerts", "key", "a")],
      ["schedules", fake("schedules", "none")],
      ["resources", fake("resources", "moves")],
    ]);
    const narrowCell = {
      wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", cells: [{ tabs: ["quota", "alerts", "schedules"] }, { panel: "resources", width: 3 }] }] }],
      narrow: ["quota", "resources"],
    };
    const decoded = await Effect.runPromise(decodeLayout(narrowCell, [...truncated.keys()]));
    const screen = hostScreen(boardOf(decoded, truncated), membersOf(truncated, layoutPanels(decoded)));
    const size = { columns: 100, rows: 6 };
    const drawn = screen.draw(0, screen.initial, size.columns, size.rows);
    const key = "quota|alerts|schedules";
    const opens = drawn.targets.filter((target) => target.state.open.get(key) !== undefined).map((target) => target.state.open.get(key));
    expect(opens).toContain("quota");
    expect(opens).toContain("alerts");
    expect(opens).not.toContain("schedules");
    const cell = plain(drawn.block[0] ?? []).slice(0, 25);
    const cadence = cell.indexOf("↻");
    expect(cadence).toBeGreaterThan(-1);
    expect(targetAt(drawn.targets, cadence + 3, 0)).toBeUndefined();
  });

  test("brackets cycle only the focused group and home arrows open a closed home tab", async () => {
    const twoTabs = {
      wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", cells: [{ tabs: ["mover", "keyed"] }, { tabs: ["shown", "wide-only"] }] }] }],
      narrow: ["mover", "keyed", "shown"],
    };
    const decoded = await Effect.runPromise(decodeLayout(twoTabs, [...mounted.keys()]));
    const screen = hostScreen(boardOf(decoded, mounted), membersOf(mounted, layoutPanels(decoded)));
    const size = { columns: 180, rows: 6 };
    const keyed = screen.press?.(0, screen.initial, "k", size) ?? screen.initial;
    expect(keyed.focus).toBe("keyed");
    const cycled = screen.press?.(0, keyed, "]", size) ?? keyed;
    expect(cycled.open.get("mover|keyed")).toBe("mover");
    expect(cycled.open.get("shown|wide-only")).toBe(screen.initial.open.get("shown|wide-only"));
    expect(cycled.focus).toBeUndefined();
    const away = screen.move(0, cycled, "up", size);
    const home = screen.move(0, away, "down", size);
    expect(home.open.get("mover|keyed")).toBe("mover");
    const frame = screen.draw(0, home, size.columns, size.rows).block.map(plain).join("\n");
    expect(frame).toContain("mover at=1");
    expect(frame).toContain("shown at=0");
  });

  test("a clipped box keeps no click target on its summary row", async () => {
    const shown = counter({ name: "tall-shown", at: 0, blurs: 0, pressed: "" });
    const deep = counter({ name: "tall-deep", at: 0, blurs: 0, pressed: "" });
    const tall: Mounted = {
      name: "tall",
      key: undefined,
      cadence: "1 second",
      reach: "none",
      refresh: Effect.void,
      pending: () => false,
      refreshing: () => false,
      freshness: () => [],
      start: {
        box: () => ({
          block: Array.from({ length: 8 }, (_, index) => [span(`tall ${index}`, "foreground")]),
          targets: [
            { row: 2, from: 0, to: 6, state: shown },
            { row: 5, from: 0, to: 6, state: deep },
          ],
        }),
        natural: () => 8,
        least: () => 1,
        glance: () => [],
      },
    };
    const solo = {
      wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", cells: [{ panel: "tall" }] }] }],
      narrow: ["tall"],
    };
    const mountedSolo = new Map([["tall", tall]]);
    const decoded = await Effect.runPromise(decodeLayout(solo, [...mountedSolo.keys()]));
    const small = hostScreen(boardOf(decoded, mountedSolo), membersOf(mountedSolo, layoutPanels(decoded)));
    const drawn = small.draw(0, small.initial, 180, 6);
    expect(drawn.block.length).toBe(6);
    expect(plain(drawn.block[5] ?? [])).toMatch(/^\+\d+ more rows/);
    expect(drawn.targets.some((target) => target.state.placed.get("tall") === shown)).toBe(true);
    expect(drawn.targets.every((target) => target.state.placed.get("tall") !== deep)).toBe(true);
    expect(drawn.targets.every((target) => target.row < 5)).toBe(true);
  });

  test("a letter no panel owns goes to every panel", async () => {
    const { frame } = await after(wide, [{ press: "x" }]);
    expect(frame).toContain("mover at=0 blurs=0 pressed=x");
    expect(frame).toContain("wide-only at=0 blurs=0 pressed=x");
  });

  test("a narrow screen shows the glance of the narrow panels in their order", async () => {
    const { frame } = await after(narrow, []);
    expect(frame.indexOf("mover at=0")).toBeLessThan(frame.indexOf("keyed at=0"));
    expect(frame.indexOf("keyed at=0")).toBeLessThan(frame.indexOf("shown at=0"));
    expect(frame).not.toContain("wide-only");
  });

  test("a narrow screen shows the focused panel alone", async () => {
    const { frame } = await after(narrow, [{ press: "k" }]);
    expect(frame).toContain("*keyed at=0 blurs=0 pressed=k");
    expect(frame).not.toContain("mover");
  });

  test("a panel the narrow screen has no place for loses the focus there", async () => {
    const { state } = await after(narrow, [{ press: "w" }]);
    expect(state.focus).toBeUndefined();
  });

  test("a focused panel gone after a shrink hands the arrows to the home panel", async () => {
    const screen = await screenAt();
    const focused = screen.press?.(0, screen.initial, "w", wide) ?? screen.initial;
    expect(focused.focus).toBe("wide-only");
    expect(screen.resized?.(0, focused, narrow).focus).toBeUndefined();
    const moved = screen.move(0, focused, "down", narrow);
    expect(moved.focus).toBeUndefined();
    const frame = screen.draw(0, moved, narrow.columns, narrow.rows).block.map(plain).join("\n");
    expect(frame).toContain("mover at=1");
  });

  test("a panel holding the whole screen keeps the focus across a shrink", async () => {
    const mover = mounted.get("mover");
    if (mover === undefined) throw new Error("no mover");
    const overlayWhole: Placed["whole"] = () => ({ block: [[span("overlay", "foreground")]], targets: [] });
    const overlayStart = (count: Count): Placed => {
      const base = counter(count);
      return {
        ...base,
        press: (key) => overlayStart({ ...count, pressed: count.pressed + key }),
        move: (move, size) => {
          const next = base.move?.(move, size);
          return next === undefined ? undefined : { ...next, whole: overlayWhole };
        },
        blur: () => overlayStart({ ...count, blurs: count.blurs + 1 }),
        whole: overlayWhole,
      };
    };
    const overlay: Mounted = {
      ...fake("overlay", "key", "o"),
      start: overlayStart({ name: "overlay", at: 0, blurs: 0, pressed: "" }),
    };
    const both = new Map([
      ["mover", mover],
      ["overlay", overlay],
    ]);
    const split = {
      wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", cells: [{ panel: "mover" }, { panel: "overlay" }] }] }],
      narrow: ["mover"],
    };
    const decoded = await Effect.runPromise(decodeLayout(split, [...both.keys()]));
    const screen = hostScreen(boardOf(decoded, both), membersOf(both, layoutPanels(decoded)));
    const focused = screen.press?.(0, screen.initial, "o", wide) ?? screen.initial;
    expect(focused.focus).toBe("overlay");
    expect(screen.resized?.(0, focused, narrow).focus).toBe("overlay");
    const moved = screen.move(0, focused, "down", narrow);
    expect(moved.focus).toBe("overlay");
    const frame = screen.draw(0, moved, narrow.columns, narrow.rows).block.map(plain).join("\n");
    expect(frame).toContain("overlay");
  });
});
