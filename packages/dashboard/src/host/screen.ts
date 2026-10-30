import { Clock, Effect } from "effect";
import {
  ageText,
  type Block,
  bottomEdgeRow,
  drawAlone,
  type Drawn,
  ellipsize,
  type Line,
  type Move,
  overlaid,
  panelWidth,
  type Placed,
  type Screen,
  type ScreenSize,
  sideBySide,
  span,
  type Target,
  widthOf,
  withinRows,
} from "@tui-dash/ui";
import { type Board, type BoardView, type BoardWide, type Group, lookOf, type Member, type Part, planOf, readSince, refreshing, savedOnly, savedSince, wideFor, wideMembers } from "./board";
import { glanceLines } from "./glance";

export interface HostState {
  // Unset at home, where the first panel that takes the arrows looks focused and gets them.
  readonly focus: string | undefined;
  // The open tab of each row of tabs, by the group's key; a group not in it shows its first tab.
  readonly open: ReadonlyMap<string, string>;
  readonly placed: ReadonlyMap<string, Placed>;
}

interface Host {
  readonly board: Board;
  readonly members: ReadonlyArray<Member>;
  readonly groups: ReadonlyArray<Group>;
  readonly live: boolean;
}

const replaced = <V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => new Map([...map, [key, value]]);

const placedOf = (state: HostState, member: Member): Placed => state.placed.get(member.id) ?? member.mounted.start;

const focusedOf = (host: Host, state: HostState): Member | undefined =>
  state.focus === undefined ? undefined : host.members.find((member) => member.id === state.focus);

const among = (members: ReadonlyArray<Member>, member: Member): boolean => members.some((other) => other.id === member.id);

const shownOn = (host: Host, size: ScreenSize): ReadonlyArray<Member> => {
  const wide = wideFor(host.board, size);
  return wide === undefined ? host.board.narrow : wideMembers(wide);
};

const visibleOn = (host: Host, state: HostState, size: ScreenSize): ReadonlyArray<Member> => {
  const wide = wideFor(host.board, size);
  if (wide === undefined) return host.board.narrow;
  const view = viewOf(host, state, size);
  return wide.rows.flatMap((row) => row.cells.flatMap((cell) => cell.groups.map((group) => view.openOf(group))));
};

const homeOn = (host: Host, size: ScreenSize): Member | undefined =>
  [...shownOn(host, size), ...host.members].find((member) => member.mounted.reach === "moves");

const viewOf = (host: Host, state: HostState, size: ScreenSize): BoardView => {
  const home = homeOn(host, size);
  return {
    placedOf: (member) => placedOf(state, member),
    openOf: (group) => group.members.find((member) => member.id === state.open.get(group.key)) ?? group.members[0],
    lit: (member) => member.id === (state.focus ?? home?.id),
    focus: state.focus,
  };
};

const withPlaced = (state: HostState, id: string, placed: Placed): HostState =>
  placed === state.placed.get(id) ? state : { ...state, placed: replaced(state.placed, id, placed) };

const blurred = (host: Host, state: HostState): HostState => {
  const left = focusedOf(host, state);
  if (left === undefined) return state;
  const placed = placedOf(state, left);
  return withPlaced(state, left.id, placed.blur?.() ?? placed);
};

const focusedOn = (host: Host, state: HostState, member: Member): HostState =>
  state.focus === member.id ? state : { ...blurred(host, state), focus: member.id };

const partOf = (host: Host, state: HostState, member: Member, size: ScreenSize): Part | undefined => {
  const wide = wideFor(host.board, size);
  if (wide === undefined) return undefined;
  return planOf(viewOf(host, state, size), wide, size)
    .flatMap((row) => row.cells.flatMap((cell) => cell.parts))
    .find((part) => among(part.group.members, member));
};

// The room a module moves through: the whole screen while it holds it, its box in the layout, or the screen it has alone.
const roomOf = (host: Host, state: HostState, member: Member, size: ScreenSize): ScreenSize => {
  const placed = placedOf(state, member);
  if (placed.whole?.(size) !== undefined) return size;
  const part = partOf(host, state, member, size);
  if (part !== undefined) return part.size;
  return { columns: size.columns, rows: Number.isFinite(size.rows) ? size.rows : placed.natural(size.columns) };
};

// A click lands on the module it hit, so that module takes the focus with the view the click picked.
const aimed = (host: Host, state: HostState, member: Member, drawn: Drawn<Placed>, x: number, y: number): Drawn<HostState> => {
  const focused = focusedOn(host, state, member);
  return {
    block: drawn.block,
    targets: drawn.targets.map((target) => ({
      row: target.row + y,
      from: target.from + x,
      to: target.to + x,
      state: { ...focused, placed: replaced(focused.placed, member.id, target.state) },
    })),
  };
};

interface TabRun {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

const tabRuns = (line: Line, from: number, to: number): ReadonlyArray<TabRun> => {
  const runs: Array<TabRun> = [];
  let at = 0;
  for (const piece of line) {
    const wide = widthOf(piece.text);
    const start = Math.max(at, from);
    const end = Math.min(at + wide, to);
    const last = runs.at(-1);
    if (piece.tab !== undefined && start < end) {
      if (last !== undefined && last.id === piece.tab && last.to === start) runs[runs.length - 1] = { id: last.id, from: last.from, to: end };
      else runs.push({ id: piece.tab, from: start, to: end });
    }
    at += wide;
  }
  return runs;
};

const tabSelected = (host: Host, shown: HostState, group: Group, member: Member): HostState => {
  const selected = member.mounted.reach === "none" ? shown : focusedOn(host, shown, member);
  const left = focusedOf(host, selected);
  return left !== undefined && among(group.members, left) && left.id !== member.id ? { ...blurred(host, selected), focus: undefined } : selected;
};

const tabTargets = (host: Host, state: HostState, part: Part, block: Block): ReadonlyArray<Target<HostState>> => {
  if (part.group.members.length < 2) return [];
  const members = new Map(part.group.members.map((member): [string, Member] => [member.mounted.name, member]));
  const targets: Array<Target<HostState>> = [];
  for (const run of tabRuns(block[0] ?? [], 0, part.size.columns)) {
    const member = members.get(run.id);
    if (member === undefined) continue;
    const shown = opened(host, state, member);
    targets.push({ row: part.y, from: part.x + run.from, to: part.x + run.to, state: tabSelected(host, shown, part.group, member) });
  }
  return targets;
};

const footRoom = (columns: number): number => columns - 6;

// The age sits in the bottom edge rather than on a row of the box, so showing it hides none of it and moves no box.
const footed = (block: Block, since: number | undefined, inflight: boolean, columns: number, now: number): Block => {
  const at = bottomEdgeRow(block);
  const edge = at === -1 ? undefined : block.at(at);
  if (edge === undefined || footRoom(columns) < widthOf("read 1m ago")) return block;
  if (since === undefined && !inflight) return block;
  const read = since === undefined ? `reading\u2026` : `read ${ageText((now - since) / 1000)} ago${inflight ? ` \u00b7 reading\u2026` : ""}`;
  return [...block.slice(0, at), overlaid(edge, 2, [span(` ${ellipsize(read, footRoom(columns))} `, "muted")]), ...block.slice(at + 1)];
};

const footedDrawn = (host: Host, member: Member, drawn: Drawn<Placed>, columns: number, now: number): Drawn<Placed> => ({
  ...drawn,
  block: footed(drawn.block, readSince(member, host.live), refreshing(member, host.live), columns, now),
});

const drawnPart = (host: Host, state: HostState, view: BoardView, part: Part, now: number): Drawn<HostState> => {
  const { member, look } = lookOf(view, part.group, part.size.columns);
  const drawn = placedOf(state, member).box(part.size, look);
  const clipped = drawn.block.length > part.size.rows;
  const framed = clipped ? drawn.block : footed(drawn.block, readSince(member, host.live), refreshing(member, host.live), part.size.columns, now);
  const block: Block = [...withinRows(framed, part.size.rows), ...Array.from({ length: Math.max(0, part.size.rows - drawn.block.length) }, () => [])];
  const landed = aimed(host, state, member, { block, targets: drawn.targets }, part.x, part.y);
  if (!clipped) return { block: landed.block, targets: [...tabTargets(host, state, part, block), ...landed.targets] };
  const horizon = part.y + part.size.rows - 1;
  const tabs = part.size.rows > 1 ? tabTargets(host, state, part, block) : [];
  return { block: landed.block, targets: [...tabs, ...landed.targets.filter((target) => target.row < horizon)] };
};

const drawWide = (host: Host, state: HostState, size: ScreenSize, wide: BoardWide, now: number): Drawn<HostState> => {
  const view = viewOf(host, state, size);
  const targets: Array<Target<HostState>> = [];
  let top = 0;
  const block = planOf(view, wide, size).flatMap((row) => {
    const start = top;
    top += row.height;
    const columns = row.cells.map((cell) => ({
      width: cell.width,
      block: cell.parts.flatMap((part) => {
        const drawn = drawnPart(host, state, view, part, now);
        targets.push(...drawn.targets.filter((target) => target.row >= start && target.row < start + row.height));
        return drawn.block;
      }),
    }));
    return sideBySide(columns, row.height);
  });
  return { block, targets };
};

const glanceOf = (host: Host, state: HostState, size: ScreenSize, now: number): Block =>
  glanceLines(
    host.board.narrow.map((member) => ({
      id: member.id,
      name: member.mounted.name,
      cadence: member.mounted.cadence,
      savedAt: savedSince(member),
      savedOnly: savedOnly(member),
      refreshing: refreshing(member, host.live),
      candidates: placedOf(state, member).glance(size.columns),
    })),
    host.board.narrowGivesWay,
    { columns: size.columns, rows: size.rows },
    now,
  );

// A module the screen has no place for keeps the focus only while it holds the whole screen.
const keptFocus = (host: Host, state: HostState, size: ScreenSize): HostState => {
  const focused = focusedOf(host, state);
  if (focused === undefined || among(visibleOn(host, state, size), focused) || placedOf(state, focused).whole?.(size) !== undefined) return state;
  return { ...blurred(host, state), focus: undefined };
};

// The focused module's whole screen wins, then the layout that fits the screen, then the focused box alone, then the glance.
const drawHost = (host: Host, drawnState: HostState, columns: number, rows: number, now: number): Drawn<HostState> => {
  const size = { columns: panelWidth(columns), rows };
  const state = keptFocus(host, drawnState, size);
  const focused = focusedOf(host, state);
  const whole = focused === undefined ? undefined : placedOf(state, focused).whole?.(size);
  const wide = wideFor(host.board, size);
  const drawn =
    focused !== undefined && whole !== undefined
      ? aimed(host, state, focused, footedDrawn(host, focused, whole, size.columns, now), 0, 0)
      : wide !== undefined && (focused === undefined || among(wideMembers(wide), focused))
        ? drawWide(host, state, size, wide, now)
        : focused !== undefined
          ? aimed(host, state, focused, footedDrawn(host, focused, drawAlone(placedOf(state, focused), columns, rows), size.columns, now), 0, 0)
          : { block: glanceOf(host, state, size, now), targets: [] as ReadonlyArray<Target<HostState>> };
  if (!Number.isFinite(rows) || drawn.block.length <= rows) return drawn;
  const block = withinRows(drawn.block, rows);
  return { block, targets: drawn.targets.filter((target) => target.row < rows - 1) };
};

const moveFrom = (host: Host, state: HostState, member: Member, move: Move, size: ScreenSize): HostState | undefined => {
  const next = placedOf(state, member).move?.(move, roomOf(host, state, member, size));
  return next === undefined ? undefined : withPlaced(state, member.id, next);
};

// At home the arrows step the home module without focusing it, and enter focuses it.
const movedHost = (host: Host, state: HostState, move: Move, size: ScreenSize): HostState => {
  const focused = focusedOf(host, state);
  if (focused === undefined) {
    const home = homeOn(host, size);
    if (home === undefined || move === "out") return state;
    if (move === "in") return { ...opened(host, state, home), focus: home.id };
    const shown = opened(host, state, home);
    return moveFrom(host, shown, home, move, size) ?? shown;
  }
  const moved = moveFrom(host, state, focused, move, size);
  if (moved !== undefined) return moved;
  if (placedOf(state, focused).move !== undefined || move === "out") return { ...blurred(host, state), focus: undefined };
  return state;
};

const opened = (host: Host, state: HostState, member: Member): HostState => {
  const holding = host.groups.filter((group) => among(group.members, member) && state.open.get(group.key) !== member.id);
  return holding.length === 0 ? state : { ...state, open: new Map([...state.open, ...holding.map((group) => [group.key, member.id] as const)]) };
};

const cycled = (host: Host, state: HostState, group: Group, delta: number): HostState => {
  if (group.members.length < 2) return state;
  const current = group.members.find((member) => member.id === state.open.get(group.key)) ?? group.members[0];
  const at = group.members.indexOf(current);
  const following = group.members[(at + delta + group.members.length) % group.members.length] ?? current;
  if (following.id === current.id) return state;
  const next = { ...state, open: new Map([...state.open, [group.key, following.id] as const]) };
  const left = focusedOf(host, next);
  if (left !== undefined && among(group.members, left) && left.id !== following.id) return { ...blurred(host, next), focus: undefined };
  return next;
};

const cycleGroup = (host: Host, state: HostState, size: ScreenSize): Group | undefined => {
  const wide = wideFor(host.board, size);
  if (wide === undefined) return undefined;
  const groups = wide.rows.flatMap((row) => row.cells.flatMap((cell) => cell.groups));
  const focused = focusedOf(host, state);
  if (focused !== undefined) return groups.find((group) => among(group.members, focused));
  const home = homeOn(host, size);
  if (home === undefined) return undefined;
  return groups.find((group) => among(group.members, home));
};

// A module's own key opens its tab, and focuses it when it takes the focus; any other letter goes to every module.
const pressedHost = (host: Host, state: HostState, key: string, size: ScreenSize): HostState => {
  if (key === "[" || key === "]") {
    const group = cycleGroup(host, state, size);
    return group === undefined ? state : cycled(host, state, group, key === "]" ? 1 : -1);
  }
  const owner = host.members.find((member) => member.mounted.key === key);
  if (owner === undefined) {
    return host.members.reduce((pressed, member) => {
      const placed = placedOf(pressed, member);
      return withPlaced(pressed, member.id, placed.press?.(key, roomOf(host, pressed, member, size)) ?? placed);
    }, state);
  }
  const shown = opened(host, state, owner);
  if (owner.mounted.reach === "none") return shown;
  const focused = focusedOn(host, shown, owner);
  const placed = placedOf(focused, owner);
  return withPlaced(focused, owner.id, placed.press?.(key, roomOf(host, focused, owner, size)) ?? placed);
};

const screenOf = (size: ScreenSize): ScreenSize => ({ columns: panelWidth(size.columns), rows: size.rows });

export const hostScreen = (board: Board, members: ReadonlyArray<Member>, live = true): Screen<number, HostState, never> => {
  const host: Host = { board, members, groups: board.wide.flatMap((wide) => wide.rows.flatMap((row) => row.cells.flatMap((cell) => cell.groups))), live };
  return {
    read: Effect.andThen(Effect.forEach(members, (member) => member.mounted.refresh, { concurrency: "unbounded", discard: true }), Clock.currentTimeMillis),
    initial: { focus: undefined, open: new Map(), placed: new Map(members.map((member) => [member.id, member.mounted.start])) },
    draw: (now, state, columns, rows) => drawHost(host, state, columns, rows, now),
    move: (_, state, move, size) => {
      const kept = keptFocus(host, state, screenOf(size));
      return keptFocus(host, movedHost(host, kept, move, screenOf(size)), screenOf(size));
    },
    press: (_, state, key, size) => {
      const kept = keptFocus(host, state, screenOf(size));
      return keptFocus(host, pressedHost(host, kept, key, screenOf(size)), screenOf(size));
    },
    link: (_, state, size) => {
      const kept = keptFocus(host, state, screenOf(size));
      const focused = focusedOf(host, kept);
      return focused === undefined ? undefined : placedOf(kept, focused).link?.(roomOf(host, kept, focused, screenOf(size)));
    },
    resized: (_, state, size) => keptFocus(host, state, screenOf(size)),
    pending: () => members.some((member) => member.mounted.pending()),
  };
};
