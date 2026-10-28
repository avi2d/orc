import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeLayout, defaultLayout, layoutPanels } from "@tui-dash/dashboard";

const known = ["quota", "session-quota", "alerts", "resources", "queues", "schedules", "tasks", "ledger"];

const refusalOf = (raw: unknown): Promise<string> =>
  Effect.runPromise(Effect.match(decodeLayout(raw, known), { onFailure: (error) => error.reason, onSuccess: () => "decoded" }));

const oneCell = (cell: unknown) => ({ wide: [{ atLeast: { columns: 100, rows: 30 }, rows: [{ height: "fill", cells: [cell] }] }] });

describe("the layout setting", () => {
  test("an absent layout is the shipped one, which leaves the ledger off", async () => {
    const layout = await Effect.runPromise(decodeLayout(undefined, known));
    expect(layout).toEqual(defaultLayout);
    expect(layoutPanels(layout)).not.toContain("ledger");
  });

  test("a layout naming only narrow keeps the shipped wide screens", async () => {
    const layout = await Effect.runPromise(decodeLayout({ narrow: ["tasks", "quota"] }, known));
    expect(layout.wide).toEqual(defaultLayout.wide);
    expect(layout.narrow).toEqual(["tasks", "quota"]);
    expect(layout.narrowGivesWay).toEqual(defaultLayout.narrowGivesWay);
  });

  test("a layout leaving out the give-way order decodes against modules that order does not name", async () => {
    const layout = await Effect.runPromise(decodeLayout({ ...oneCell({ panel: "tasks" }), narrow: ["tasks"] }, ["tasks"]));
    expect(layout.narrow).toEqual(["tasks"]);
  });

  test("an optional panel joins the dashboard by being named in the layout", async () => {
    const layout = await Effect.runPromise(decodeLayout({ ...oneCell({ tabs: ["ledger", "tasks"] }), narrow: ["ledger"] }, known));
    expect(layoutPanels(layout)).toEqual(["ledger", "tasks"]);
  });

  const refusals: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a misspelt key", { narow: ["quota"] }, 'Expected no excess property\n  at ["narow"]'],
    ["a misspelt cell key", oneCell({ panle: "quota" }), 'Expected no excess property\n  at ["wide"][0]["rows"][0]["cells"][0]["panle"]'],
    ["a panel no module is called", { narrow: ["vpn"] }, `no panel is called vpn; the panels are ${known.join(", ")}`],
    ["a panel twice on one wide screen", oneCell({ stack: [{ panel: "quota" }, { tabs: ["tasks", "quota"] }] }), "wide[0] shows quota twice"],
    ["a panel twice in narrow", { narrow: ["quota", "quota"] }, "narrow shows quota twice"],
    ["a panel twice in the narrow give-way order", { narrowGivesWay: ["alerts", "alerts"] }, "narrowGivesWay names alerts twice"],
    ["an unknown panel in the narrow give-way order", { narrowGivesWay: ["alert"] }, "no panel is called alert; the panels are " + known.join(", ")],
    ["an empty wide list", { wide: [], narrow: ["quota"] }, 'Expected a value with a length of at least 1\n  at ["wide"]'],
    ["an empty narrow list", { narrow: [] }, 'Expected a value with a length of at least 1\n  at ["narrow"]'],
    ["a share of nothing", oneCell({ panel: "quota", width: 0 }), 'Expected a value greater than or equal to 1\n  at ["wide"][0]["rows"][0]["cells"][0]["width"]'],
    ["tabs naming no panel", oneCell({ tabs: [] }), 'Expected a value with a length of at least 1\n  at ["wide"][0]["rows"][0]["cells"][0]["tabs"]'],
    ["a cell naming both a panel and tabs", oneCell({ panel: "quota", tabs: ["tasks"] }), 'names exactly one of panel, tabs or stack\n  at ["wide"][0]["rows"][0]["cells"][0]'],
    ["a cell naming no panel", oneCell({ width: 2 }), 'names exactly one of panel, tabs or stack\n  at ["wide"][0]["rows"][0]["cells"][0]'],
  ];
  for (const [name, raw, issue] of refusals) {
    test(`refuses ${name} with one issue saying where`, async () => {
      expect(await refusalOf(raw)).toBe(`layout is not valid: ${issue}`);
    });
  }
});
