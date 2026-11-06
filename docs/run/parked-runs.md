---
kind: reference
---
# Parked runs
A run that no-mistakes stops on review questions you have not answered parks its task instead of closing it failed.
The beat moves the task back to `new` with `parked_branch` and `parked_questions` in its file, each question with its id and text.
It prints `parked <task-id> on <branch> for the captain's answer to <question-ids>`.
Each later beat prints `waits <task-id>: parked on <branch> for the captain's answer to <question-ids>` and never starts it.
To answer one question, run `orc backlog answer <task-id> <question-id>=<text>`.
The task file keeps your text and its time on that question, and the other questions stay parked.
Once every question has an answer, the next beat starts the task again on the same branch with `--answer <question-id>=<text>` for each one.
The run resumes there and hands your answers to no-mistakes, so no new branch and no fresh run starts.
If the resumed run stops on new questions, the task parks again with those, and it keeps the answers it already has.
`orc backlog` shows a parked task as `parked (<question-ids>)`, and `orc backlog --json` gives every task a `parked`, either `null` or the branch and the questions with their answers.
