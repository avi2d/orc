import { type GalleryStory, galleryStories } from "./gallery-stories"

type GroupedStory = Extract<GalleryStory, { readonly component: "uniformRows" }>

export const findGalleryStories = (query: string): ReadonlyArray<GalleryStory> => {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "")
  return galleryStories.filter((story) => {
    const name = `${story.component} ${story.label} ${story.id}`.toLowerCase()
    return words.every((word) => name.includes(word))
  })
}

export const visibleGalleryRows = (story: GroupedStory, folded: ReadonlySet<string>): GroupedStory["rows"] => {
  let hideRuns = false
  return story.rows.filter((row) => {
    if (row.kind === "group") {
      hideRuns = folded.has(row.key)
      return true
    }
    return !hideRuns
  })
}
