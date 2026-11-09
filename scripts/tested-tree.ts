#!/usr/bin/env bun
import { Console, Effect, Schema } from "effect";
import { git } from "@avi2dg/checks/core/git.ts";
import { runMain } from "@avi2dg/checks/core/main.ts";

const NAME = "tested-tree";

class TreeRefused extends Schema.TaggedError<TreeRefused>()("TreeRefused", {
  message: Schema.String,
}) {}

const RELEASE_SUBJECT = /^chore: release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

// The squash merge names the pull request it lands.
const PULL_NUMBER = / \(#(\d+)\)$/;

const lastTag = git(["describe", "--tags", "--abbrev=0", "--match=v[0-9]*.[0-9]*.[0-9]*", "HEAD"]).pipe(
  Effect.map((tag) => tag.trim()),
  Effect.catchTag("GitFailure", () => Effect.succeed("")),
  Effect.map((described) => (described === "" ? undefined : described)),
);

const check = Effect.gen(function* () {
  const [head = "", subject = ""] = (yield* git(["log", "-1", "--format=%H%n%s", "HEAD"])).split("\n");
  const version = RELEASE_SUBJECT.exec(subject)?.[1];
  if (version === undefined) {
    return yield* new TreeRefused({
      message: `${head.slice(0, 12)} is no release commit, so no release pull request tested it; merge the release pull request to land the release, and tag nothing by hand`,
    });
  }
  const [, number = ""] = PULL_NUMBER.exec(subject) ?? [];
  if (number === "") {
    return yield* new TreeRefused({
      message: `${head.slice(0, 12)} names no pull request, so no release pull request tested it; merge the release pull request to land the release, and tag nothing by hand`,
    });
  }
  yield* git(["fetch", "--quiet", "origin", `refs/pull/${number}/head`]);
  const [landed = "", tested = ""] = (yield* git(["rev-parse", "HEAD^{tree}", "FETCH_HEAD^{tree}"]))
    .split("\n")
    .map((line) => line.trim());
  if (landed === tested) {
    yield* Console.log(`${NAME}: ${head.slice(0, 12)} matches the tree pull request #${number} tested`);
    return true;
  }
  const pointed = (yield* git(["tag", "--points-at", "HEAD"])).split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (pointed.length > 0) {
    return yield* new TreeRefused({
      message: `${head.slice(0, 12)} differs from the ${tested.slice(0, 12)} tree pull request #${number} tested, so main moved after the full run; ${pointed.join(", ")} already tags this commit, so resolve that tag before the release can proceed`,
    });
  }
  const since = yield* lastTag;
  const returned = since === undefined ? "the version it held before this release" : since.slice(1);
  return yield* new TreeRefused({
    message: `${head.slice(0, 12)} differs from the ${tested.slice(0, 12)} tree pull request #${number} tested, so main moved after the full run; open a \`chore: cancel the unpublished ${version}\` pull request that returns package.json to ${returned} and commits what \`bun run build\` then writes to CHANGELOG.md, and the next release-pr run cuts the release again with every change since ${since ?? "the first commit"}`,
  });
});

if (import.meta.main) runMain(NAME, check);
