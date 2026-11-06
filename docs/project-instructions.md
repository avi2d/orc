---
kind: reference
---
# Give a project its own instructions
To give a project rules of its own, add `"instructions": "<file>"` to that project in `projects.json`.
The file is Markdown, and its path is absolute or relative to the folder that holds `projects.json`.
Each run of that project's tasks and `orc chat` add it to Pi's system prompt and name it on their first line of output.
A project instructions file replaces a discovered APPEND_SYSTEM.md.
Orc refuses an instructions value that is not a file path, and a list naming an instructions file that does not exist.
A project with no `instructions` gets no extra rules.
