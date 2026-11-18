---
kind: reference
---
# Merging a task's PR
To land a closed task's PR, run `orc merge <task-id>`.
Orc reads the PR with `gh pr view` and merges nothing when any of these holds:

- The task names no PR.
- The PR is closed or merged, not open.
- A check is red, a check has not reported, or no check has reported at all.
  Only the newest attempt of each run and check counts, so a cancelled run that re-ran green reads green.
- The branch is behind its base by the compare API's `behind_by`, so update the branch and let its checks run again.

Each refusal starts `orc merge refused <task-id> and merged nothing` and names every reason.
Otherwise orc runs `gh pr merge <url> --squash --match-head-commit <sha>` at the head it checked, so a push after the check merges nothing.

A project in `projects.json` may add `"yolo": true`, and a project with no `yolo` reads as `false`.
Orc refuses any `yolo` other than `true` or `false` with `the project <name> names yolo <value>, which is not true or false`.
`orc merge` takes `--basis captain-word`, the default, or `--basis yolo-green`.
The chat merges with `captain-word` only when you said to merge that PR.
It merges with `yolo-green` when you ask it to merge a yolo project's PR and the PR is green.
Orc refuses `yolo-green` for a project without `yolo` true.
Either basis meets every refusal above.

`yolo-green` also reads the PR's changed files from the GitHub pull request files API and refuses a change that waits for your merge word:

- A release, which changes `CHANGELOG.md` or the `version` of a `package.json`.
- A deletion, which removes a file.
- A workflow file change under `.github/workflows/`.
- A secret change, to a file named `.env`, `.env.<name>`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, or a name with `secret` in it.

Each such refusal ends `which waits for the captain's merge word`.
The beat merges a closed ship task's PR on `yolo-green` by itself once its project has `yolo` true and every check is green.
A PR with a red check or a check that has not reported stays unmerged.
A PR with a change that waits for your word stays unmerged, and its `pr-ready` item in `orc attention` names that change.
