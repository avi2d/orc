---
kind: reference
---
# Seeing runs
To list recent runs, run `orc runs`.
Orc keeps its records in `~/.orc`, outside every project repo.
Set `ORC_HOME` to keep them somewhere else.
To print the same facts as JSON, run `orc runs --json`.
Every JSON document names its version first as `schema`, starting at `orc.runs.v1`.
To see one run step by step, run `orc show <run-id>`.
It lists each step with its agent, session, signals, latest score and evidence, every file as a full link.
To print the same facts as JSON, run `orc show <run-id> --json`.
Its JSON document names its version first as `schema`, starting at `orc.show.v1`.
To score a step, run `orc score <run-id> <step> <1 to 5> [note]`.
Use fix#1 to score the first fix attempt and plain fix scores the latest attempt in execution order.
Use the step id from orc show JSON to score one resumed checks row when an attempt ran twice.
Orc score refuses a score outside 1 to 5 with no write.
Orc score refuses an unknown run or an unknown step with no write.
Orc score keeps one row per score and orc show prints the latest score beside the signals.
To count the gates and rules past runs kept hitting, run `orc refusals`.
To print the same facts as JSON, run `orc refusals --json`.
Its JSON document names its version first as `schema`, starting at `orc.refusals.v1`.
Each row counts the runs that hit one gate and rule, so two failing rounds in one run count once.
