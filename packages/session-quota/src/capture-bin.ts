#!/usr/bin/env bun
import { BunFileSystem, BunRuntime, BunStdio } from "@effect/platform-bun";
import { Effect, Layer, Runtime } from "effect";
import { binArgsExit, usageText } from "@tui-dash/ui/src/bin-args.ts";
import { capture } from "./capture";

const usage = usageText("tui-dash-capture (pi-call | claude-statusline) [--help]", "Read one JSON call on stdin and append its record to the capture ledger.", [
  "-h, --help      print this usage and exit",
]);

const argv = Bun.argv.slice(2);

const binExit = binArgsExit(argv, usage, new Set(["--help", "-h"]));
if (binExit !== undefined) process.exit(binExit);

// Bun's stdin stays open after the read gives up, and an open stdin keeps the process alive, so the writer exits itself.
BunRuntime.runMain(capture.pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunStdio.layer))), {
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => {
      onExit(code);
      process.exit(code);
    }),
});
