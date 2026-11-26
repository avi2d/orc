import { EventEmitter, once } from "node:events";
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing";
import { Effect } from "effect";
import { ScreenDrawObserver } from "@avi2dg/orc-ui";

export const createLiveTestRenderer = async (size: Pick<TestRendererOptions, "width" | "height">) => {
  const setup = await createTestRenderer(size);
  const events = new EventEmitter();
  let revision = 0;
  const onDraw = () => {
    revision += 1;
    events.emit("draw");
  };
  const start = <A, E>(program: Effect.Effect<A, E>) => Effect.runFork(program.pipe(Effect.provideService(ScreenDrawObserver, onDraw)));

  let capture = Promise.resolve({ revision: 0, text: "" });
  const captureLatest = () => {
    capture = capture.then(async (previous) => {
      if (revision === previous.revision) return previous;
      const drawing = revision;
      await setup.renderOnce();
      return { revision: drawing, text: setup.captureCharFrame() };
    });
    return capture;
  };

  const frameWhere = async (matches: (frame: string) => boolean, after = 0): Promise<string> => {
    const signal = AbortSignal.timeout(4_500);
    let last = await capture;
    while (!signal.aborted) {
      if (revision > last.revision) last = await captureLatest();
      if (revision > last.revision) continue;
      if (last.revision > after && matches(last.text)) return last.text;
      try {
        await once(events, "draw", { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    throw new Error(`no frame matched, last was:\n${last.text}`);
  };

  return { ...setup, start, frameWhere, nextFrame: () => frameWhere(() => true, revision) };
};
