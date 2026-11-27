import { type Card, type Filter, filterCards, projectsOf } from "./agents"

interface FilterChoice<A> {
  readonly value: A
  readonly name: string
  readonly count: number
}

export interface FilterMenu<A> {
  readonly chosen: FilterChoice<A>
  readonly choices: ReadonlyArray<FilterChoice<A>>
}

export type ProjectChoice = Filter

export const projectMenu = (cards: ReadonlyArray<Card>, filter: Filter): FilterMenu<ProjectChoice> => {
  const choices: ReadonlyArray<FilterChoice<ProjectChoice>> = [
    { value: { project: null, allRuns: false }, name: "All" },
    ...projectsOf(cards).map((project) => ({ value: { project, allRuns: false }, name: project })),
    { value: { project: null, allRuns: true }, name: "All runs" }
  ].map((choice) => ({ ...choice, count: filterCards(cards, choice.value).length }))
  const chosen = choices.find((choice) => choice.value.project === filter.project && choice.value.allRuns === filter.allRuns)
    ?? { value: filter, name: filter.project ?? "All", count: 0 }
  return { chosen, choices }
}
