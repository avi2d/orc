export type ProviderRoom =
  | { readonly kind: "room" }
  | { readonly kind: "no-room"; readonly reason: string }
