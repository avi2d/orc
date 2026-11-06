---
kind: reference
---
# Follow up on your upstream contributions
To have orc follow the issues and pull requests you filed on other people's repositories, add `"upstream": ["<url>"]` to that project in `projects.json`.
Each entry is a GitHub issue or pull request URL, such as `https://github.com/owner/repo/pull/12`.
Only `orc beat` reads the list, through the `gh` login of the machine that runs it, so a private repository needs a login that can see it.
The beat only reads upstream and never comments, pushes or opens anything there.
The first beat to read a contribution records its state and adds no task.
When a later beat finds it closed, merged, reopened, commented on, reviewed or pushed to, it adds one scout task for the project naming the URL and the change, and the chat posts the change.
A contribution the beat cannot read prints `upstream of <project>: <reason>`, with the URL and why in the reason, and adds no task.
Orc refuses an `upstream` that is not a list of such URLs, and a project with no `upstream` watches nothing.
