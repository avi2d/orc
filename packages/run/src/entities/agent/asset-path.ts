import { fileURLToPath } from "node:url"

export const assetPath = (file: string): string =>
  file.startsWith("./") ? fileURLToPath(new URL(file, import.meta.url)) : file
