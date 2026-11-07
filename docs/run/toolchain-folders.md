---
kind: how-to
---
# Granting toolchain folders to the sandbox
With the default sandbox, the sandbox reads the system folders, the Homebrew and `/usr/local` program folders and `/nix`.
It also reads the one mise install folder each of `bun`, `node` and `pi` resolves to.
With the default sandbox, orc refuses a runtime the PATH finds anywhere else, naming the runtime and its path.
To run a runtime from another install folder, such as the one Bun's own installer makes in your home:

1. Set `ORC_TOOLCHAIN_DIRS` to the install folders, separated by colons.
1. Run the task as usual.

With the default sandbox, orc grants a named folder only when a runtime and the file its link points to both sit inside it.
Orc refuses a relative entry and a folder that holds HOME, because the sandbox reads each granted folder whole.
To let the sandbox read a folder that holds no runtime, such as a cache a project's install reads:

1. List the folder under `sandbox.read` in `$ORC_HOME/config.json`, beside `providers`, as in `"sandbox": { "read": ["/Users/me/.cache/avi2dg-checks"] }`.
1. Run the task as usual.

The sandbox reads each listed folder and writes none of them, so the install and Pi see the same files.
Orc refuses a relative entry and a folder that holds HOME, for the same reason as `ORC_TOOLCHAIN_DIRS`.

`packages/run/src/nono-profile.ts` holds the `ToolchainResolver` interface and the default layout, and `packages/run/src/nono-exec.ts` takes another resolver through its `toolchain` option.
