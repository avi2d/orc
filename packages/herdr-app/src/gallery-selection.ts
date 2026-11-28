import { type GalleryRow, type GalleryStory, galleryStories } from "./gallery-stories"

type GroupedStory = Extract<GalleryStory, { readonly component: "uniformRows" }>

type ShownGalleryRow =
  | Extract<GalleryRow, { readonly kind: "run" }>
  | Extract<GalleryRow, { readonly kind: "group" }> & { readonly count: number }

export const findGalleryStories = (query: string): ReadonlyArray<GalleryStory> => {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "")
  return galleryStories.filter((story) => {
    const name = `${story.component} ${story.label} ${story.id}`.toLowerCase()
    return words.every((word) => name.includes(word))
  })
}

const runsUnder = (rows: ReadonlyArray<GalleryRow>, group: number): number => {
  const next = rows.findIndex((row, index) => index > group && row.kind === "group")
  return rows.slice(group + 1, next === -1 ? undefined : next).length
}

export const visibleGalleryRows = (story: GroupedStory, folded: ReadonlySet<string>): ReadonlyArray<ShownGalleryRow> => {
  let hideRuns = false
  return story.rows.flatMap((row, index): ReadonlyArray<ShownGalleryRow> => {
    if (row.kind === "group") {
      hideRuns = folded.has(row.key)
      return [{ ...row, count: runsUnder(story.rows, index) }]
    }
    return hideRuns ? [] : [row]
  })
}
