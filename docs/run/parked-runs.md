---
kind: reference
---
# Parked runs
A run that [no-mistakes](https://github.com/kunchenguid/no-mistakes) stops on review questions waits at that gate first, as [Running a task](running-a-task.md) shows.
It waits 30 minutes, or the `ORC_ANSWER_WAIT_SECONDS` its machine sets.
A finding marked `ask-user`, or with any action other than `auto-fix` and `no-op`, is one of those questions, with the finding's id and text.
The question `gate-cap` is another, asked once orc has answered 20 gates in the run without an outcome.
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

## Park a task

A run whose wait ends with a question unanswered parks its task instead of closing it failed.
The beat moves the task back to `new` with `parked_branch`, `parked_origin`, and `parked_questions` in its file.
The origin records the machine and run id.
Each question keeps its id, text, blocking flag, and the time it was asked.
It prints `parked <task-id> on <branch> for the captain's answer to <question-ids>`.
A question the attention queue owns for the decider shows as `the decider's answer to <question-ids>` instead, after an `and` when you answer the others.
Each later beat prints `waits <task-id>: parked on <branch> for the captain's answer to <question-ids>` and never starts it.
That line names a question the attention queue owns for the decider the same way, as `the decider's answer to <question-ids>`, and so does the `wait` that `orc backlog --json` gives the task.

## Resume a parked task

To answer one question, run `orc backlog answer <task-id> <question-id>=<text>`.
When a later round asks an id it already asked, the answer goes to the entry that is still open.
The task file keeps your text and its time on that question, and the other questions stay parked.
Once every question has an answer, the next beat resumes the task on its original machine and branch with `--answer <question-id>=<text>` for each id.
When an id was asked more than once, the resume hands the latest answer for that id.
A machine with more room cannot take that resume.
The beat waits if the original machine has no room or no configured checkout, or if the runner cannot find the recorded run.
A task parked before its origin was recorded also waits rather than guessing a machine.
Its wait reads `the parked task has no recorded machine and run; record them with orc backlog origin <task-id> <machine> <run-id> before resuming`.
Find the run id in `orc runs --json` on that machine, then run `orc backlog origin <task-id> <machine> <run-id>` to record it, and the next beat resumes the task there.

## Check the resume

Orc refuses a machine `dispatch.json` does not name, a task that is not parked, and a task that already has an origin.
It reads the task's run on that machine the way the resume check does, and refuses a run id the runner does not report for that task.
The command takes the task file by rename the way `orc backlog hold` does, so it and a beat never both win.
The queue and run check the recorded run id before using its progress.
The queued command carries that id in `ORC_DISPATCH_RESUME_RUN`.
If the latest resumable run has changed or disappeared, Orc refuses the resume instead of starting fresh implementation.
The resumed attempt keeps the earlier completed steps and hands your answers to no-mistakes.
If the resumed run stops on new questions, the task parks again with those beside the questions it kept, and it keeps the answers it already has.
An answer given after the beat last read the waiting run is kept too.
A task whose every blocking question has an answer can resume when its original machine and run are available.
`orc backlog` shows a parked task as `parked (<question-ids>)`.
`orc backlog --json` gives every task a `parked`, either `null` or the branch, the recorded origin, and the questions with their times, their blocking flag, their answers, and for a worker question its options and recommendation.
Older parked records have no `origin` field.

## A looping run
A run whose Pi fails one command 6 times in a row pauses the run and asks the question `looping`, as [How orc runs Pi](how-orc-runs-pi.md) shows.
It waits for your answer the way a run waits at its gate, with the same `asking.json`, wait and hand-off.
The attention queue owns that question for you, so the decider never answers it.
An answer that opens with `continue` resumes the same Pi session, and the rest of the answer reaches Pi as your guidance.
Any other answer stops the run, and it ends `stopped` with your answer in its end reason.
A ship run whose wait ends unanswered parks its task on its branch like any other question.
Answer it with `orc backlog answer <task-id> looping=continue <guidance>` to resume the paused step's session on that branch, or `looping=stop` to end the task's run before Pi starts again.
A report run has no branch to park on, so a wait that ends unanswered ends it failed.

## A worker question
Pi asks you a question mid-run with the `orc_ask` tool, as [How orc runs Pi](how-orc-runs-pi.md) shows.
The tool takes the `question`, an optional `context`, the `options` each with a `text`, an `outcome` and an optional `picture`, a `recommendation`, and `blocks`.
The `outcome` says what choosing that option leads to, and the `recommendation` repeats the text of the option Pi recommends.
The tool refuses a question with no options, an option with no outcome, or a recommendation that names none of the options, and tells Pi why so it can ask again.
Pi sets `blocks` to true when it cannot go on without the answer.
Orc names each question `ask-<n>`, numbering from the highest id the task ever asked, and writes it to the run's `asking.json` beside the gate and loop questions.
The question's text holds the question, then `Context:` and the context, then each option lettered `A)`, `B)` and on with `Leads to:` and its outcome, then `Recommended:` and the recommended option.
The parked question in the task record keeps the options and the recommendation beside the text.
The beat opens a `worker-question` item for it, as [The attention queue](attention-queue.md) shows, and hands its answer to the run the way it does at a gate.

### Ask with blocking

A blocking question holds Pi for 10 minutes, or for the `ORC_ANSWER_WAIT_SECONDS` its machine sets when that is shorter.
An answer within the wait is the tool's result, and Pi carries on.
When no answer comes, the tool tells Pi so, and orc stops Pi at the end of that turn with `orc stopped Pi when no answer to its question ask-<n> came in time` in the end reason.
A ship run then parks its task on its branch for every open question.
Answer it with `orc backlog answer <task-id> ask-<n>=<text>`, and the beat resumes the task on the same machine and branch.
The resumed run hands your answer to the same Pi session as `The captain answered your question ask-<n>: <text>`.
A scout or task run has no branch to park on, so it ends failed with the question in its end reason.

### Ask without blocking

A non-blocking question returns at once, and Pi carries on.
An answer that reaches the run while Pi runs is added to the result of Pi's next tool call.
A non-blocking question still open when the run ends stays in the attention queue, and its item is withdrawn when the task closes.
