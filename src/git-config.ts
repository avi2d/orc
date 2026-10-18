import type { Path } from "effect"

// An http(s) URL's userinfo is sent as the request's credentials.
const credentialBearingUrl = (raw: string): boolean => {
  if (!URL.canParse(raw)) {
    return false
  }
  const url = new URL(raw)
  return url.password !== "" || (url.username !== "" && (url.protocol === "https:" || url.protocol === "http:"))
}

const urlRewriteSuffixes: ReadonlyArray<string> = [".insteadof", ".pushinsteadof"]

// Git lowercases the section and variable name of every key it lists.
const credentialBearingEntry = (key: string, value: string): boolean => {
  if (key.startsWith("http.") && key.endsWith(".extraheader")) {
    return true
  }
  if (key.startsWith("credential.") && key.endsWith(".helper")) {
    return true
  }
  if (key.startsWith("remote.") && (key.endsWith(".url") || key.endsWith(".pushurl"))) {
    return credentialBearingUrl(value)
  }
  const rewrite = urlRewriteSuffixes.find((suffix) => key.startsWith("url.") && key.endsWith(suffix))
  return rewrite !== undefined && credentialBearingUrl(key.slice("url.".length, -rewrite.length))
}

// The listing is `git config --list -z`: a key with no newline is a valueless boolean.
const entries = (listing: string): ReadonlyArray<readonly [string, string]> =>
  listing.split("\0").filter((entry) => entry !== "").map((entry) => {
    const newline = entry.indexOf("\n")
    return newline === -1 ? [entry, ""] : [entry.slice(0, newline), entry.slice(newline + 1)]
  })

export const credentialBearingKeys = (listing: string): ReadonlyArray<string> =>
  entries(listing).flatMap(([key, value]) =>
    credentialBearingEntry(key, value) ? [`${key.slice(0, key.indexOf("."))}${key.slice(key.lastIndexOf("."))}`] : []
  )

export const includeTargets = (
  path: Path.Path,
  home: string | undefined,
  file: string,
  listing: string
): ReadonlyArray<string> =>
  entries(listing).flatMap(([key, value]) => {
    if (key !== "include.path" && !(key.startsWith("includeif.") && key.endsWith(".path"))) {
      return []
    }
    if (!value.startsWith("~/")) {
      return [path.resolve(path.dirname(file), value)]
    }
    return home === undefined ? [] : [path.join(home, value.slice(2))]
  })
