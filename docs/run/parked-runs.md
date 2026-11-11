---
kind: reference
---
# Parked runs
A run that no-mistakes stops on review questions waits at that gate first, as [Running a task](running-a-task.md) shows.
It waits 30 minutes, or the `ORC_ANSWER_WAIT_SECONDS` its machine sets.
An `ask-user` finding is one of those questions, with the finding's id and text.
The next beat writes the questions into the started task's `parked_questions`.
It prints `asking <task-id> on <machine>: the run waits until <time> for the captain's answer to <question-ids>` only for the questions the attention queue owns for you.
`orc backlog` shows that task as `started asking (<question-ids>)`.
The chat posts only the questions the attention queue owns for you, as it does a parked task's.
Each question also waits in `orc attention` until an answer or a withdraw takes it out, as [The attention queue](attention-queue.md) shows.
The beat first gives each question to the decider, which answers a routine one in that beat or escalates it to you, as [The decider](attention-queue.md#the-decider) shows.
Answer one with `orc backlog answer <task-id> <question-id>=<text>`, and the next beat hands every answer the run waits on to it through `orc runner answer` on its machine.
It prints `handed <question-ids> to the run of <task-id> on <machine>`, and the run carries on at the same gate with no new dispatch.
A wait on several questions gets every answer given so far each time the beat hands one more.
A question the run asks again at a later wait is open again, and the chat posts it once more when the attention queue owns it for you.

A run whose wait ends with a question unanswered parks its task instead of closing it failed.
The beat moves the task back to `new` with `parked_branch` and `parked_questions` in its file, each question with its id, its text and the time it was asked.
It prints `parked <task-id> on <branch> for the captain's answer to <question-ids>`.
A question the attention queue owns for the decider shows as `the decider's answer to <question-ids>` instead, after an `and` when you answer the others.
Each later beat prints `waits <task-id>: parked on <branch> for the captain's answer to <question-ids>` and never starts it.
To answer one question, run `orc backlog answer <task-id> <question-id>=<text>`.
The task file keeps your text and its time on that question, and the other questions stay parked.
Once every question has an answer, the next beat starts the task again on the same branch with `--answer <question-id>=<text>` for each one.
The run resumes there and hands your answers to no-mistakes, so no new branch and no fresh run starts.
If the resumed run stops on new questions, the task parks again with those, and it keeps the answers it already has.
An answer given after the beat last read the waiting run is kept too.
So a task whose every question has an answer starts again at once.
`orc backlog` shows a parked task as `parked (<question-ids>)`, and `orc backlog --json` gives every task a `parked`, either `null` or the branch and the questions with the time each was asked and their answers.
