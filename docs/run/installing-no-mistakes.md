---
kind: how-to
---
# Installing no-mistakes
The install script of [no-mistakes](https://github.com/kunchenguid/no-mistakes) fetches the release GitHub marks latest, and upstream marks releases after v1.84.0 as prereleases, so the script installs a release orc refuses.
To install v1.100.2 instead:

1. Pick the archive for your machine: `no-mistakes-v1.100.2-darwin-arm64.tar.gz`, `no-mistakes-v1.100.2-darwin-amd64.tar.gz`, `no-mistakes-v1.100.2-linux-arm64.tar.gz` or `no-mistakes-v1.100.2-linux-amd64.tar.gz`.
1. Run `mkdir -p ~/.local/bin` to make the folder it goes in.
1. Run `curl -fsSL https://github.com/kunchenguid/no-mistakes/releases/download/v1.100.2/ARCHIVE | tar xz -C ~/.local/bin no-mistakes`, with the archive in place of `ARCHIVE`.
1. Put `~/.local/bin` on your PATH.
1. Run `no-mistakes --version` to check it.

no-mistakes prints `no-mistakes version v1.100.2`.

no-mistakes reviews with its own agent, which `agent` in `~/.no-mistakes/config.yaml` names.
Its daemon finds that agent on the PATH your login shell sets, not the PATH of the shell that runs orc.
With `agent: auto` it takes the first agent it finds, so to review with Pi:

1. Set `agent: pi` in `~/.no-mistakes/config.yaml`.
1. Put the folder holding `pi` on the PATH in your login shell profile, such as `~/.zprofile`.
1. Run `no-mistakes daemon restart`.

no-mistakes opens the PR only for an origin on a provider it supports, such as GitHub.
For another origin it pushes the branch and skips the `pr` and `ci` steps, and orc's result names that skip and its reason.

## Ask each review question for a recommended option

Orc's decider answers a question with its recommended option only when a line of the question starts with `Recommended:`.
no-mistakes follows review instructions from `review.path_instructions` in its config, and treats the run's intent as data, so the rule goes in your config.
Orc never writes `~/.no-mistakes/config.yaml`.
Add this entry under `review.path_instructions` in that file, beside any entries already there:

```yaml
review:
  path_instructions:
    - path: "**/*"
      instructions: |
        Every question the review asks names one recommended option.
        Put that option on its own line that starts with "Recommended:", followed by the option's words.
```

The entry applies to every repository no-mistakes gates on this machine, from its next run.
