import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { AlertSettings } from "@tui-dash/schema";
import { tasksSettings } from "@tui-dash/tasks";
import { decodeSettings, noSettings, panelModule } from "@tui-dash/ui";

const decoded = <S>(section: string, settings: Parameters<typeof decodeSettings<S>>[1], raw: unknown) =>
  Effect.runPromise(Effect.result(decodeSettings(section, settings, raw)));

const refusal = async <S>(section: string, settings: Parameters<typeof decodeSettings<S>>[1], raw: unknown): Promise<string> => {
  const result = await decoded(section, settings, raw);
  return Result.isFailure(result) ? result.failure.reason : "decoded";
};

// Oracle: the approved design D1, strict about a key it does not know and a default for every key, with each panel's settings at panels.<id>.
// Rejects a decoder that lets a misspelt key through on a panel with no settings, or that needs a section the file leaves out.
describe("a panel's settings", () => {
  test("refuse any key on a panel that takes none, naming the section and the key", async () => {
    expect(await refusal("panels.quota", noSettings, { anything: 1 })).toBe('panels.quota is not valid: this panel takes no settings\n  at ["anything"]');
    expect(await refusal("panels.quota", noSettings, 5)).toBe("panels.quota is not valid: Expected object");
  });

  test("refuse a written null like any other bad value", async () => {
    expect(await refusal("panels.quota", noSettings, null)).toBe("panels.quota is not valid: Expected object");
  });

  test("take an absent or empty section on a panel that takes none", async () => {
    expect(await refusal("panels.quota", noSettings, undefined)).toBe("decoded");
    expect(await refusal("panels.quota", noSettings, {})).toBe("decoded");
  });

  test("default the tasks panel to this machine alone and refuse a misspelt key", async () => {
    expect(await decoded("panels.tasks", tasksSettings, undefined)).toEqual(await decoded("panels.tasks", tasksSettings, { remote: false }));
    const misspelt = await refusal("panels.tasks", tasksSettings, { remot: true });
    expect(misspelt).toStartWith("panels.tasks is not valid: ");
    expect(misspelt).toContain('["remot"]');
    const mistyped = await refusal("panels.tasks", tasksSettings, { remote: "yes" });
    expect(mistyped).toStartWith("panels.tasks is not valid: ");
    expect(mistyped).toContain('["remote"]');
  });

  // Oracle: the README's alert settings, where heavyLoad takes sustainedMinutes and nothing spelt otherwise.
  // Rejects an alerts section whose misspelt key leaves the rule on its default without a word.
  test("refuse a misspelt alerts key, naming panels.alerts and the key", async () => {
    const misspelt = await refusal("panels.alerts", AlertSettings, { heavyLoad: { sustainedMinute: 1 } });
    expect(misspelt).toStartWith("panels.alerts is not valid: ");
    expect(misspelt).toContain("sustainedMinute");
  });

  test("are refused before the panel runs, prints or mounts", async () => {
    const reached: Array<string> = [];
    const reach = (what: string) => Effect.sync(() => void reached.push(what));
    const probe = panelModule({
      id: "probe",
      about: "records what it was asked to do",
      settings: Schema.Struct({ wide: Schema.optionalKey(Schema.Boolean) }),
      mount: () => Effect.die("mounted"),
      run: () => reach("run"),
      print: () => reach("print"),
    });
    const frame = { width: 50, height: 30, color: false };
    for (const refused of [probe.run({ wid: true }), probe.print({ wid: true }, frame), Effect.scoped(probe.mount({ wid: true }))]) {
      expect(await Effect.runPromise(Effect.flip(refused))).toMatchObject({ reason: expect.stringContaining("panels.probe is not valid: ") });
    }
    await Effect.runPromise(probe.print({ wide: true }, frame));
    expect(reached).toEqual(["print"]);
  });
});
