export interface Contribution {
  readonly url: string
  readonly owner: string
  readonly repo: string
  readonly number: number
}

// GitHub ignores case in owner and repository names and numbers issues and pull requests from one sequence, and an owner holds no dot.
export const contributionId = (contribution: Contribution): string =>
  contribution.owner.toLowerCase() + "." + contribution.repo.toLowerCase() + "." + String(contribution.number)

const contributionPattern = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/([1-9]\d*)$/

const notUpstream = (name: string, value: unknown): string =>
  "the project " + name + " names upstream " + JSON.stringify(value) + ", which is not a list of GitHub issue or pull request URLs"

export const parsedUpstream = (name: string, upstream: unknown): ReadonlyArray<Contribution> | string => {
  if (!Array.isArray(upstream)) {
    return notUpstream(name, upstream)
  }
  const contributions: Array<Contribution> = []
  for (const entry of upstream) {
    const match = typeof entry === "string" ? contributionPattern.exec(entry) : null
    if (match === null) {
      return "the project " + name + " names the upstream entry " + JSON.stringify(entry) + ", which is not a GitHub issue or pull request URL such as https://github.com/owner/repo/pull/12"
    }
    contributions.push({ url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) })
  }
  const ids = contributions.map(contributionId)
  const again = contributions.find((contribution, index) => ids.indexOf(contributionId(contribution)) !== index)
  return again === undefined ? contributions : "the project " + name + " names the upstream URL " + again.url + " twice"
}
