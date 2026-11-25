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
When that version is newer than the running one, it runs `bun add -g @avi2dg/orc@<version>`.
When the versions are equal, or the running orc is newer, it installs nothing.
A registry read that fails or takes more than 15 seconds installs nothing, and the command prints why.
Run `orc update --json` for an `orc.update.v1` document.
To upgrade by hand instead, run `bun add -g @avi2dg/orc`, the same command that installs orc.

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
| `output` | What the install command printed, or `null` when it did not run |

The command exits 0 for `installed` and `current`, and non-zero for `failed`.

## Related topics

- [Configuring providers](configuring-providers.md)
- [Where every source file is](layout.md)
