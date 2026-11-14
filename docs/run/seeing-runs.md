---
kind: reference
---
# Seeing runs
To list recent runs, run `orc runs`.
Orc keeps its records in `~/.orc`, outside every project repo.
Set `ORC_HOME` to keep them somewhere else.
To print the same facts as JSON, run `orc runs --json`.
Every JSON document names its version first as `schema`, starting at `orc.runs.v1`.
Each run in it also gives `title`, the first line of its task file, and `endReason`, the reason it ended.
Its `step` is the step running now, else the step that started last, as an id, name, attempt and status, and `null` before the first step.
Its `questions` counts the questions a running run waits on you to answer, and is 0 otherwise.
Its `task` is the backlog task id its `orc/<task-id>` or `orc/<task-id>-parent` branch names, and `null` on any other branch.
Its `machine` is the dispatch machine the beat claimed for the run, which reaches `orc run` as `ORC_RUN_MACHINE`.
A run you start by hand without `ORC_RUN_MACHINE` shows `null`.
Its `worktree` is the checkout the run works in: the task copy for a ship run, the project checkout for a report run.
Runs recorded before these facts show each as `null`.
To see one run step by step, run `orc show <run-id>`.
It lists each step with its agent, session, signals, latest score and evidence, every file as a full link.
To print the same facts as JSON, run `orc show <run-id> --json`.
Its JSON document names its version first as `schema`, starting at `orc.show.v1`.
Its `run` gives the same `task`, `machine` and `worktree` as `orc runs --json`.
Each step gives the `model` and `thinking` level its agent ran with, and `null` for a step no agent ran.
To print one step's output, run `orc log <run-id> <step-id>` with the step's `id` from that JSON.
An implement step prints `agent.log` and a fix step its `fix-<attempt>.log`, which Pi appends to as it works.
A checks or no-mistakes step prints the file it wrote.
A step whose output is not written yet prints nothing.
To score a step, run `orc score <run-id> <step> <1 to 5> [note]`.
Use fix#1 to score the first fix attempt and plain fix scores the latest attempt in execution order.
Use the step id from orc show JSON to score one resumed checks row when an attempt ran twice.
Orc score refuses a score outside 1 to 5 with no write.
Orc score refuses an unknown run or an unknown step with no write.
Orc score keeps one row per score and orc show prints the latest score beside the signals.
To count the gates and rules past runs kept hitting, run `orc refusals`.
To print the same facts as JSON, run `orc refusals --json`.
Its JSON document names its version first as `schema`, starting at `orc.refusals.v1`.
Each row counts the runs that hit one gate, and one rule where the failure names a stable rule code, so two failing rounds in one run count once.
