import { type Card, type CardStatus, type Filter, cardStatuses, filterCards, projectsOf } from "./agents"

interface FilterChoice<A> {
  readonly value: A | null
  readonly name: string
  readonly count: number
}

export interface FilterMenu<A> {
  readonly title: "Project" | "Status"
  readonly chosen: FilterChoice<A>
  readonly choices: ReadonlyArray<FilterChoice<A>>
}

const filterMenu = <A extends string>(title: FilterMenu<A>["title"], values: ReadonlyArray<A>, chosen: A | null, cards: ReadonlyArray<Card>, matches: (card: Card, value: A) => boolean): FilterMenu<A> => {
  const choices: ReadonlyArray<FilterChoice<A>> = [
    { value: null, name: "All", count: cards.length },
    ...values.map((value) => ({ value, name: value, count: cards.filter((card) => matches(card, value)).length }))
  ]
  return { title, chosen: choices.find((choice) => choice.value === chosen) ?? { value: chosen, name: chosen ?? "All", count: 0 }, choices }
}

export type ProjectChoice = { readonly project: string | null; readonly allRuns: boolean }

export const projectMenu = (cards: ReadonlyArray<Card>, filter: Filter): FilterMenu<ProjectChoice> => {
  const forStatus = cards.filter((card) => filter.status === null || card.standing.status === filter.status)
  const choices: ReadonlyArray<FilterChoice<ProjectChoice>> = [
    { value: { project: null, allRuns: false }, name: "All", count: forStatus.filter((card) => card.known).length },
    ...projectsOf(cards).map((project) => ({ value: { project, allRuns: false }, name: project, count: forStatus.filter((card) => card.project === project).length })),
    { value: { project: null, allRuns: true }, name: "All runs", count: forStatus.length }
  ]
  const chosen = choices.find((choice) => choice.value?.project === filter.project && choice.value.allRuns === filter.allRuns)
    ?? { value: { project: filter.project, allRuns: filter.allRuns }, name: filter.project ?? "All", count: 0 }
  return { title: "Project", chosen, choices }
}

export const statusMenu = (cards: ReadonlyArray<Card>, filter: Filter): FilterMenu<CardStatus> =>
  filterMenu("Status", cardStatuses, filter.status, filterCards(cards, { ...filter, status: null }), (card, status) => card.standing.status === status)
