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

export const runsHeader = { width: 360, padding: 12, gap: 8, top: 10, controlHeight: 32, selectorWidth: 132, foldWidth: 32, menuWidth: 200 } as const

export const projectMenuPosition = () => ({
  left: runsHeader.width - runsHeader.padding - runsHeader.foldWidth - runsHeader.gap - runsHeader.menuWidth,
  top: runsHeader.top + runsHeader.controlHeight + 4
})

export const projectMenu = (cards: ReadonlyArray<Card>, filter: Filter): FilterMenu<ProjectChoice> => {
  const choices: ReadonlyArray<FilterChoice<ProjectChoice>> = [
    { value: { project: null, allRuns: false }, name: "Configured projects" },
    ...projectsOf(cards).map((project) => ({ value: { project, allRuns: false }, name: project })),
    { value: { project: null, allRuns: true }, name: "All runs" }
  ].map((choice) => ({ ...choice, count: filterCards(cards, choice.value).length }))
  const chosen = choices.find((choice) => choice.value.project === filter.project && choice.value.allRuns === filter.allRuns)
    ?? { value: filter, name: filter.project ?? (filter.allRuns ? "All runs" : "Configured projects"), count: 0 }
  return { chosen, choices }
}
