import { Schema } from "effect"
import type { Env } from "./chat-command"
import { DependInput, DropInput, NoteInput, PriorityInput, RetryInput, SendBackInput, StopInput, ThreadInput } from "./chat-inputs"
import { type ChatTool, runTool } from "./chat-run"

export const priorityTool = (env: Env): ChatTool => ({
  name: "orc_backlog_priority",
  label: "Set an orc task's priority",
  description:
    "Sets or clears the priority of one new task through orc backlog priority, which orders the beat's starts: 0 starts first, 4 starts after the other priorities, and none clears it. orc refuses a task that is taken, started or closed.",
  parameters: Schema.toJsonSchemaDocument(PriorityInput).schema,
  execute: (_toolCallId, params) =>
    runTool(PriorityInput, "orc_backlog_priority", params, env, (input) => ["backlog", "priority", input.id, String(input.priority)])
})

export const taskTools = (env: Env): ReadonlyArray<ChatTool> => [
  {
    name: "orc_backlog_stop",
    label: "Stop an orc task's run",
    description:
      "Kills a started task's run through the machine that started it with orc backlog stop, and closes the task stopped. orc refuses a task that is not started, and a task on a machine it cannot reach, which the captain closes by hand. A new task ends with orc_backlog_drop instead.",
    parameters: Schema.toJsonSchemaDocument(StopInput).schema,
    execute: (_toolCallId, params) => runTool(StopInput, "orc_backlog_stop", params, env, (input) => ["backlog", "stop", input.id])
  },
  {
    name: "orc_backlog_retry",
    label: "Retry an orc task",
    description: "Returns a failed or stopped task to the backlog on the machine it ran on, reusing its kept branch when one exists. A failed start keeps its pending answers and any machine pin.",
    parameters: Schema.toJsonSchemaDocument(RetryInput).schema,
    execute: (_toolCallId, params) => runTool(RetryInput, "orc_backlog_retry", params, env, (input) => ["backlog", "retry", input.id])
  },
  {
    name: "orc_backlog_drop",
    label: "Drop a new orc task",
    description:
      "Closes a new task as dropped with the reason it never runs, through orc backlog drop. orc refuses a taken or started task, which ends with orc_backlog_stop instead, and a task that is already closed.",
    parameters: Schema.toJsonSchemaDocument(DropInput).schema,
    execute: (_toolCallId, params) => runTool(DropInput, "orc_backlog_drop", params, env, (input) => ["backlog", "drop", input.id, input.reason])
  },
  {
    name: "orc_backlog_send_back",
    label: "Send an orc task's PR back",
    description:
      "Moves a closed task whose PR is still open back to new through orc backlog send-back, parked on its branch with the captain's words as the review. The next beat resumes its run on that branch, and the push updates the same PR. Sending it back again before the beat starts it adds more words. orc refuses a task that is neither closed nor sent back, names no PR, or whose PR is merged or closed.",
    parameters: Schema.toJsonSchemaDocument(SendBackInput).schema,
    execute: (_toolCallId, params) => runTool(SendBackInput, "orc_backlog_send_back", params, env, (input) => ["backlog", "send-back", input.id, input.words])
  },
  {
    name: "orc_backlog_note",
    label: "Leave a note on an orc task",
    description:
      "Appends a note to a task's notes file through orc backlog note. A note holds nothing and answers nothing, so it never changes when the beat starts the task. orc refuses an id the backlog does not hold.",
    parameters: Schema.toJsonSchemaDocument(NoteInput).schema,
    execute: (_toolCallId, params) => runTool(NoteInput, "orc_backlog_note", params, env, (input) => ["backlog", "note", input.id, input.words])
  },
  {
    name: "orc_backlog_depend",
    label: "Change the tasks an orc task waits for",
    description:
      "Replaces the whole list of tasks a new or held task waits for through orc backlog depend, or empties it. orc refuses a task that is taken, started, closed or parked for the captain's answer, an id the backlog does not hold, and a dependency that would wait on itself in a loop.",
    parameters: Schema.toJsonSchemaDocument(DependInput).schema,
    execute: (_toolCallId, params) =>
      runTool(DependInput, "orc_backlog_depend", params, env, (input) =>
        ["backlog", "depend", input.id, ...(input.on.length === 0 ? ["--clear"] : ["--on", input.on.join(",")])])
  },
  {
    name: "orc_backlog_thread",
    label: "Read an orc task's conversation",
    description:
      "Returns orc backlog thread: a task's holds, questions, decisions, answers, deliveries, withdrawals and notes, oldest first, then its answers under Decided by the owner and Decided by the agent, each agent answer with its basis. It works on a closed task too, and orc refuses an id the backlog does not hold.",
    parameters: Schema.toJsonSchemaDocument(ThreadInput).schema,
    execute: (_toolCallId, params) => runTool(ThreadInput, "orc_backlog_thread", params, env, (input) => ["backlog", "thread", input.id])
  }
]
