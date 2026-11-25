---
kind: how-to
---
# Updating orc

Run `orc update` on a machine to move its orc to the newest published release.
The command installs only when the npm registry holds a newer version than the orc that runs it.

## Update orc

To update orc on a machine:

1. Run `orc update`.
1. Read the line it prints, which names the version it found and the version that runs.

`orc update` reads the newest version of `@avi2dg/orc` from the registry `npm_config_registry` names, else from `https://registry.npmjs.org`.
When that version is newer than the running one, a Bun global install runs `bun add -g @avi2dg/orc@<version>`.
If the machine uses a launcher that reads `~/.local/share/orc/release`, Orc prepares the new release before changing that file.
An `update.command` overrides both install methods.
When the versions are equal, or the running orc is newer, it installs nothing.
A registry read that fails or takes more than 15 seconds installs nothing, and the command prints why.
Run `orc update --json` for an `orc.update.v1` document.
To upgrade by hand instead, run `bun add -g @avi2dg/orc`, the same command that installs orc.

## Update a versioned checkout

If your launcher reads the version from `~/.local/share/orc/release`, run `orc update` through that launcher.
Orc detects the launcher when its running entry point resolves to `~/.local/share/orc/v<version>/packages/run/src/bin.ts` or its compiled executable resolves to `~/.local/share/orc/v<version>/orc`.
For example, if `release` holds `1.2.3`, the launcher starts `v1.2.3/packages/run/src/bin.ts` with Bun or runs `v1.2.3/orc`.

If the launcher starts the source entry, Orc clones the new version tag, installs its production dependencies from the lockfile with the Bun that runs orc, and checks that the new checkout prints the expected version.
If the launcher runs the compiled `orc`, Orc downloads the archive for its platform and the archive's `.sha256` file from the GitHub release, as [Release assets](release-assets.md) lists them.
Orc then checks the archive's SHA-256, unpacks it into `v<version>`, and checks that the new `orc` prints the expected version, so the update needs no Bun.
If the version directory already exists, Orc checks only the entry the launcher would run, the source entry or the compiled `orc`.
If any step fails, the launcher keeps the old release.
After an install, run `orc --version` through the launcher to see the new version.
Runs that already started still use their old checkout.

## Update a linked checkout

A machine that runs orc from a linked checkout updates the checkout, not the global package.
To update it, set `update.command` in `~/.orc/config.json` to the command that brings the checkout up to date:

```json
{
  "providers": [],
  "update": { "command": ["sh", "-c", "cd ~/src/orc && git pull --ff-only && bun install"] }
}
```

`update.command` is a list of words, run without a shell unless the list starts one.
Orc replaces `{version}` in each word after the first with the version it found.

## The orc.update.v1 document

| Key | What it holds |
| --- | --- |
| `schema` | `orc.update.v1` |
| `found` | The newest version the registry named, or `null` when the read failed |
| `running` | The version of the orc that ran the command |
| `outcome` | `installed`, `current` or `failed` |
| `detail` | Why the update failed, or `null` |
| `output` | The installer's output, or `null` if not reported |
| `retryable` | Optional. If present and `false`, the failure needs a change before retrying helps |

The command exits 0 for `installed` and `current`, and non-zero for `failed`.

## Related topics

- [The beat and task runs](beat-runs.md#updating-orc-on-dispatch-machines)
- [Configuring providers](configuring-providers.md)
- [Release assets](release-assets.md)
- [Where every source file is](layout.md)
