export type DetailsState = "closed" | "hover" | "pinned"

export type DetailsEvent = "enter" | "leave" | "press" | "escape" | "outside"

export const detailsAfter = (state: DetailsState, event: DetailsEvent): DetailsState => {
  switch (event) {
    case "enter":
      return state === "closed" ? "hover" : state
    case "leave":
      return state === "hover" ? "closed" : state
    case "press":
      return state === "pinned" ? "closed" : "pinned"
    case "escape":
    case "outside":
      return "closed"
  }
}

export const returnsFocus = (state: DetailsState, event: DetailsEvent): boolean => state !== "closed" && (event === "escape" || event === "outside")
