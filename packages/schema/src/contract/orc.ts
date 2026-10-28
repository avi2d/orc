import { Schema } from "effect";
import { decodeJson, type Decoded } from "../decode";

export interface OrcStage {
  readonly name: string;
  readonly status: string;
  readonly detail: string | undefined;
}

export interface OrcRun {
  readonly id: string;
  readonly branch: string | undefined;
  readonly stages: ReadonlyArray<OrcStage>;
}

export interface OrcSnapshot {
  readonly runs: ReadonlyArray<OrcRun>;
}

const OrcRunsJson = Schema.Struct({
  schema: Schema.Literal("orc.runs.v1"),
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      branch: Schema.optional(Schema.String),
    }),
  ),
});

const OrcShowJson = Schema.Struct({
  schema: Schema.Literal("orc.show.v1"),
  run: Schema.Struct({
    id: Schema.String,
    branch: Schema.optional(Schema.String),
  }),
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      score: Schema.NullOr(Schema.Struct({ note: Schema.String })),
    }),
  ),
});

export const decodeOrcRuns = (text: string): Decoded<OrcSnapshot> => {
  const parsed = decodeJson(OrcRunsJson)(text);
  if (parsed.kind !== "ok") return parsed;
  return {
    kind: "ok",
    value: { runs: parsed.value.runs.map((run) => ({ id: run.id, branch: run.branch ?? undefined, stages: [] })) },
  };
};

export const decodeOrcShow = (text: string): Decoded<OrcSnapshot> => {
  const parsed = decodeJson(OrcShowJson)(text);
  if (parsed.kind !== "ok") return parsed;
  return {
    kind: "ok",
    value: {
      runs: [
        {
          id: parsed.value.run.id,
          branch: parsed.value.run.branch ?? undefined,
          stages: parsed.value.steps.map((step) => ({
            name: step.name,
            status: step.status,
            // The score note is the step's only human-written line.
            detail: step.score?.note ?? undefined,
          })),
        },
      ],
    },
  };
};
