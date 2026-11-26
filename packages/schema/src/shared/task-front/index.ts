import { Schema } from "effect";

export const taskStateFields = {
  beat: Schema.optional(Schema.String),
  taken_for: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  taken_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  start_log: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["done", "failed", "stopped", "start-failed", "dropped"])),
  closed_at: Schema.optional(Schema.String),
};

const TaskStateFront = Schema.Struct(taskStateFields);
type TaskStateFront = typeof TaskStateFront.Type;

export const claimOf = (front: TaskStateFront) =>
  front.beat === undefined || front.taken_for === undefined || front.account === undefined || front.taken_at === undefined
    ? null
    : { beat: front.beat, machine: front.taken_for, account: front.account, takenAt: front.taken_at };

export const startedOf = (front: TaskStateFront) =>
  front.started_at === undefined ? null : { at: front.started_at, log: front.start_log ?? "" };
