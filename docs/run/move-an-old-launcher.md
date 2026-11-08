---
kind: reference
---
# Move an old launcher to the run package
After the release that moves orc into the run package, relink the launcher on the machine that has it.
Enter packages/run and run `bun link` to point the launcher at the new entry point.
Then run `orc --version` and confirm it prints the version `packages/run/package.json` names.
The release performs no automated handoff, so you run these steps when the release lands.
