import { readFileSync } from "node:fs";
import { join } from "node:path";

export const fixture = (relative: string): string =>
  readFileSync(join(import.meta.dir, "..", "fixtures", relative), "utf8");
