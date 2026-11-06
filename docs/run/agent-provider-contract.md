---
kind: reference
---
# The agent provider contract
Orc runs Pi through Sandcastle's `pi` agent provider, and another Sandcastle provider takes its place on these terms.

- Orc passes `ORC_COMPLETE` as the completion signal, and its prompt asks the agent to print it on its own line once the work is committed.
- The provider reports the session id of each iteration, and its session storage reads that session's JSONL back from the host sessions folder.
- The host session file name ends in the session id and `.jsonl`, which is how orc finds the file and records the id for a resume.
- Orc counts the step complete only when the session's final assistant message stopped with `stop` and holds `ORC_COMPLETE` on its own line.
- On resume orc passes the recorded id as `resumeSession`, and the provider continues that session instead of starting a new one.
- Orc sums the `usage` input and output counts each session message carries into the run's token totals.

`packages/run/src/pi.ts` builds the provider and checks the final reply, and `packages/run/src/run-loop.ts` reads the session after each run.
