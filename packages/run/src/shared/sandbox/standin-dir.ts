export const heavyDirSuffix = "/heavy/bin"

export const ciOnlyDirSuffix = "/heavy/ci-only"

export const isStandinDir = (entry: string): boolean => entry.endsWith(heavyDirSuffix) || entry.endsWith(ciOnlyDirSuffix)
