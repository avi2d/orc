import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Result, Schema } from "effect";

const Manifest = Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)) });

export const installedSubquo = (base: string, platform: string, arch: string): string | undefined => {
  try {
    const require = createRequire(base);
    const root = require.resolve("@avi2dg/subquo/package.json");
    const manifest = Schema.decodeUnknownResult(Manifest)(JSON.parse(readFileSync(root, "utf8")));
    if (Result.isFailure(manifest)) return undefined;
    const platformPackage = createRequire(root).resolve("@avi2dg/subquo-" + platform + "-" + arch + "/package.json");
    const binary = join(dirname(platformPackage), "subquo-" + manifest.success.version);
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
};

export const subquoProgram = (): string =>
  installedSubquo(import.meta.path, process.platform, process.arch) ?? installedSubquo(process.execPath, process.platform, process.arch) ?? "subquo";
