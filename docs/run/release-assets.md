---
kind: reference
---
# Release assets

Each orc release on GitHub carries a compiled orc for each platform, as a Bun bytecode build that runs without Bun installed.
The release job runs `bun run release:assets` on a macOS arm64 runner and on a Linux x64 runner, and uploads the files it writes to the release.

## Asset names

| File | What it holds |
| --- | --- |
| `orc-<version>-darwin-arm64.tar.gz` | The compiled orc for macOS on Apple silicon, and the [Herdr App](https://herdr.dev) files |
| `orc-<version>-darwin-arm64.tar.gz.sha256` | The SHA-256 checksum of the macOS archive |
| `orc-<version>-linux-x64.tar.gz` | The compiled orc for Linux on x64, and the Herdr App files |
| `orc-<version>-linux-x64.tar.gz.sha256` | The SHA-256 checksum of the Linux archive |

`<version>` is the release version without the `v` of its tag, such as `0.21.0` for the tag `v0.21.0`.
On Windows, orc runs inside WSL and takes the Linux x64 archive.

## Archive contents

| Entry | What it is |
| --- | --- |
| `orc` | The executable that `bun run compile` builds |
| `herdr-app/` | The built Herdr App mods, layouts and `keys.json`, which `orc app install` copies |

The archive has no top folder.
Unpack it into one folder, such as `tar -xzf orc-0.21.0-linux-x64.tar.gz -C ~/.orc/bin`, because the compiled orc reads `herdr-app` from the folder that holds it.

## Checksum file

Each `.sha256` file holds one line in the `sha256sum` format: the archive's SHA-256 in lowercase hex, two spaces and the archive's name.
Check a downloaded archive in its folder with `sha256sum -c orc-0.21.0-linux-x64.tar.gz.sha256`, or with `shasum -a 256 -c` on macOS.

## Build the assets by hand

`bun run release:assets` builds the archive for the platform it runs on and writes both files to `dist/release-assets`.
Give it a folder to write them elsewhere, such as `bun run release:assets /tmp/assets`.
It prints the path of each file it wrote, one per line.

## Related topics

- [Updating orc](updating-orc.md)
- [Contribute](../contribute.md)
