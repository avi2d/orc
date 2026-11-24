import { settings } from "herdr"

export const monospace = (): string => {
  const family = settings()["font_family"]
  return typeof family === "string" ? family : "Menlo"
}
