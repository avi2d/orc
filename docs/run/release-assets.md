---
kind: reference
---
# Release assets

Each Orc release on [GitHub](https://github.com) carries an archive with `orc`, `orc-dash`, `orc-dash-capture`, and the heavy tool stand-in.
The executables are [Bun](https://bun.com) bytecode builds that run without Bun installed.
The archive also holds the bundled [Herdr App](https://herdr.dev), which Herdr loads as mods.
The `assets` job of `.github/workflows/main.yml` runs after the `release` job has written the GitHub release.
The job runs `bun run release:assets` on macOS arm64 and Linux x64.
The build runs both dashboard executables with `--help` before the job attaches the archives and checksums to the release.
The `@avi2dg/checks` kit writes that job, because `checks.config.ts` sets `releaseAssets: true`.

## Asset names

| File | What it holds |
| --- | --- |
| `orc-<version>-darwin-arm64.tar.gz` | The release archive for macOS on Apple silicon |
| `orc-<version>-darwin-arm64.tar.gz.sha256` | The SHA-256 checksum of the macOS archive |
| `orc-<version>-linux-x64.tar.gz` | The release archive for Linux on x64 |
| `orc-<version>-linux-x64.tar.gz.sha256` | The SHA-256 checksum of the Linux archive |

`<version>` is the release version without the `v` of its tag, such as `0.21.0` for the tag `v0.21.0`.
On Windows, orc runs inside WSL and takes the Linux x64 archive.

## Archive contents

| Entry | What it is |
| --- | --- |
| `orc` | The executable that `bun run compile` builds |
| `orc-dash` | The [dashboard command](../dash.md) |
| `orc-dash-capture` | The [session quota capture command](../session-quota/capture.md) |
| `heavy-standin` | The heavy tool stand-in that `packages/run/scripts/build-heavy-standin.ts` builds |
| `herdr-app/` | The built Herdr App mods, layouts and `keys.json`, which `orc app install` copies |

The archive has no top folder.
Unpack it into one folder, such as `tar -xzf orc-0.21.0-linux-x64.tar.gz -C ~/.orc/bin`, because the compiled orc reads `herdr-app` from the folder that holds it.

## Checksum file

Each `.sha256` file holds one line in the `sha256sum` format: the archive's SHA-256 in lowercase hex, two spaces and the archive's name.
Check a downloaded archive in its folder with `sha256sum -c orc-0.21.0-linux-x64.tar.gz.sha256`, or with `shasum -a 256 -c` on macOS.

## Build the assets by hand

`bun run release:assets` builds the archive for the platform it runs on and writes both files to `release-assets/` at the repository root.
Give it a folder to write them elsewhere, such as `bun run release:assets /tmp/assets`.
It prints the path of each file it wrote, one per line.

## Related topics

- [Updating orc](updating-orc.md)
- [Contribute](../contribute.md)
