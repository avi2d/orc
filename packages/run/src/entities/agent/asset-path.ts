export const assetPath = (file: string): string => Bun.fileURLToPath(new URL(file, import.meta.url))
