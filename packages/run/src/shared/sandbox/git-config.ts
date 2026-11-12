import type { Path } from "effect"

// Git hands the address after a `<transport>::` prefix to git-remote-<transport> as the URL it connects to.
const explicitHelperPrefix = /^[A-Za-z0-9][A-Za-z0-9+.-]*::/

// An http(s) URL's userinfo is sent as the request's credentials.
const credentialBearingUrl = (raw: string): boolean => {
  const url = URL.parse(raw.replace(explicitHelperPrefix, ""))
  return url !== null && (url.password !== "" || (url.username !== "" && (url.protocol === "https:" || url.protocol === "http:")))
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
  if ((key.startsWith("remote.") || key.startsWith("submodule.")) && (key.endsWith(".url") || key.endsWith(".pushurl"))) {
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

export const submoduleCheckouts = (path: Path.Path, gitmodules: string, listing: string): ReadonlyArray<string> =>
  entries(listing).flatMap(([key, value]) =>
    key.startsWith("submodule.") && key.endsWith(".path") ? [path.resolve(path.dirname(gitmodules), value)] : []
  )

export const includePathKeys = "^include(if\\..*)?\\.path$"

// The listing is `git config --type=path --get-regexp -z` over includePathKeys, so git has already expanded each pathname.
// Normalizing `..` or resolving the including file's symlinks would name a different file than the one git opens.
export const includeTargets = (path: Path.Path, file: string, listing: string): ReadonlyArray<string> =>
  entries(listing).map(([, value]) => (path.isAbsolute(value) ? value : `${path.dirname(file)}/${value}`))
