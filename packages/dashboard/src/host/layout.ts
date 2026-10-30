import { Effect, Result, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { SettingsRefused } from "@tui-dash/ui";

const PanelId = Schema.String;

// A NonEmptyArray refuses an empty list as a missing first entry, which reads as a typo rather than as nothing listed.
const atLeastOne = <S extends Schema.Top>(item: S) => Schema.Array(item).check(Schema.isMinLength(1));

const Panels = atLeastOne(PanelId);

const Share = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const Rows = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const namesOne = (input: unknown, kinds: string) => Effect.fail(new SchemaIssue.InvalidValue({ message: `names exactly one of ${kinds}` }, input));

// A union of the shapes would report a wrong key once for every shape it tried, so the keys decode together and the shape is picked after.
const SlotInput = Schema.Struct({ panel: Schema.optionalKey(PanelId), tabs: Schema.optionalKey(Panels) });

const SlotShape = Schema.Union([Schema.Struct({ panel: PanelId }), Schema.Struct({ tabs: Panels })]);

const Slot = SlotInput.pipe(
  Schema.decodeTo(
    SlotShape,
    SchemaTransformation.transformEffect({
      decode: ({ panel, tabs }): Effect.Effect<typeof SlotShape.Type, SchemaIssue.Issue> => {
        if (panel !== undefined && tabs === undefined) return Effect.succeed({ panel });
        if (tabs !== undefined && panel === undefined) return Effect.succeed({ tabs });
        return namesOne({ panel, tabs }, "panel or tabs");
      },
      encode: Effect.succeed,
    }),
  ),
);

const CellInput = Schema.Struct({
  panel: Schema.optionalKey(PanelId),
  tabs: Schema.optionalKey(Panels),
  stack: Schema.optionalKey(atLeastOne(Slot)),
  width: Schema.optionalKey(Share),
});

const CellShape = Schema.Union([
  Schema.Struct({ panel: PanelId, width: Schema.optionalKey(Share) }),
  Schema.Struct({ tabs: Panels, width: Schema.optionalKey(Share) }),
  Schema.Struct({ stack: atLeastOne(SlotShape), width: Schema.optionalKey(Share) }),
]);

const Cell = CellInput.pipe(
  Schema.decodeTo(
    CellShape,
    SchemaTransformation.transformEffect({
      decode: (cell): Effect.Effect<typeof CellShape.Type, SchemaIssue.Issue> => {
        const { panel, tabs, stack, ...share } = cell;
        if (panel !== undefined && tabs === undefined && stack === undefined) return Effect.succeed({ panel, ...share });
        if (tabs !== undefined && panel === undefined && stack === undefined) return Effect.succeed({ tabs, ...share });
        if (stack !== undefined && panel === undefined && tabs === undefined) return Effect.succeed({ stack, ...share });
        return namesOne(cell, "panel, tabs or stack");
      },
      encode: Effect.succeed,
    }),
  ),
);

const Cells = atLeastOne(Cell);

const Row = Schema.Union([
  Schema.Struct({
    height: Schema.Literal("auto"),
    atMost: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1, exclusiveMinimum: true }))),
    least: Schema.optionalKey(Rows),
    cells: Cells,
  }),
  Schema.Struct({ height: Schema.Literal("fill"), least: Schema.optionalKey(Rows), cells: Cells }),
]);

const Wide = Schema.Struct({
  atLeast: Schema.Struct({ columns: Rows, rows: Rows }),
  rows: atLeastOne(Row),
});

export type Slot = typeof Slot.Type;

export type Cell = typeof Cell.Type;

export type Row = typeof Row.Type;

export type Wide = typeof Wide.Type;

export interface Layout {
  // The first entry the screen is at least as big as lays the boxes out, and a screen smaller than all of them shows the narrow glance.
  readonly wide: ReadonlyArray<Wide>;
  readonly narrow: ReadonlyArray<string>;
  // The narrow glance's panels in the order they give up rows when it does not fit; the rest follow, the last first.
  // A panel named here and absent from narrow gives up nothing, so narrow can be changed alone.
  readonly narrowGivesWay: ReadonlyArray<string>;
}

const topRow: Row = {
  height: "auto",
  atMost: 0.55,
  least: 8,
  cells: [{ panel: "quota" }, { tabs: ["session-quota", "alerts"] }],
};

const lowerRow = (tasksShare: number): Row => ({
  height: "fill",
  cells: [{ stack: [{ panel: "resources" }, { tabs: ["queues", "schedules", "dispatch"] }] }, { panel: "tasks", width: tasksShare }],
});

export const defaultLayout: Layout = {
  wide: [
    { atLeast: { columns: 240, rows: 36 }, rows: [topRow, lowerRow(2)] },
    { atLeast: { columns: 120, rows: 36 }, rows: [topRow, lowerRow(1)] },
  ],
  narrow: ["quota", "session-quota", "queues", "dispatch", "resources", "alerts", "tasks"],
  narrowGivesWay: ["alerts", "quota", "session-quota"],
};

const LayoutSettings = Schema.Struct({
  wide: atLeastOne(Wide).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultLayout.wide))),
  narrow: atLeastOne(PanelId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultLayout.narrow))),
  narrowGivesWay: Schema.optionalKey(Schema.Array(PanelId)),
});

type LayoutInput = typeof LayoutSettings.Type;

export const slotPanels = (slot: Slot | Cell): ReadonlyArray<string> => {
  if ("panel" in slot) return [slot.panel];
  if ("tabs" in slot) return slot.tabs;
  return slot.stack.flatMap(slotPanels);
};

const widePanels = (wide: Wide): ReadonlyArray<string> => wide.rows.flatMap((row) => row.cells.flatMap(slotPanels));

// In layout order, so the first panel that takes the arrows is the one the screen starts on.
export const layoutPanels = (layout: Pick<Layout, "wide" | "narrow">): ReadonlyArray<string> => [...new Set([...layout.wide.flatMap(widePanels), ...layout.narrow])];

const twiceIn = (panels: ReadonlyArray<string>): string | undefined => panels.find((panel, index) => panels.indexOf(panel) !== index);

// One module keeps one view, so a panel shown twice on one screen would move both boxes at once.
// The shipped give-way order names panels a module list may lack, so only names the setting wrote are checked.
const refusal = (layout: LayoutInput, known: ReadonlyArray<string>): string | undefined => {
  const givesWay = layout.narrowGivesWay ?? [];
  const unknown = [...layoutPanels(layout), ...givesWay].find((panel) => !known.includes(panel));
  if (unknown !== undefined) return `no panel is called ${unknown}; the panels are ${known.join(", ")}`;
  for (const [index, wide] of layout.wide.entries()) {
    const twice = twiceIn(widePanels(wide));
    if (twice !== undefined) return `wide[${index}] shows ${twice} twice`;
  }
  const twice = twiceIn(layout.narrow);
  if (twice !== undefined) return `narrow shows ${twice} twice`;
  const named = twiceIn(givesWay);
  return named === undefined ? undefined : `narrowGivesWay names ${named} twice`;
};

const strictly = { errors: "first", onExcessProperty: "error" } as const;

export const decodeLayout = (raw: unknown, known: ReadonlyArray<string>): Effect.Effect<Layout, SettingsRefused> => {
  const refused = (issue: string) => Effect.fail(new SettingsRefused({ section: "layout", issue }));
  if (raw === undefined) return Effect.succeed(defaultLayout);
  const decoded = Schema.decodeUnknownResult(LayoutSettings)(raw, strictly);
  if (Result.isFailure(decoded)) return refused(decoded.failure.message);
  const issue = refusal(decoded.success, known);
  if (issue !== undefined) return refused(issue);
  const { wide, narrow, narrowGivesWay = defaultLayout.narrowGivesWay } = decoded.success;
  return Effect.succeed({ wide, narrow, narrowGivesWay });
};
