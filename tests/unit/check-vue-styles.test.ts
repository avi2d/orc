import { expect, test } from "bun:test"
import { failuresOf, styleBlocksOf } from "../../scripts/check-vue-styles"

const component = (styleLines: number): string =>
  [
    "<script setup lang=\"ts\">",
    "const shown = true",
    "</script>",
    "",
    "<template>",
    "  <p v-if=\"shown\">Hi</p>",
    "</template>",
    "",
    "<style>",
    ...Array.from({ length: styleLines }, (_, index) => ".rule-" + index.toString() + " { color: red; }"),
    "</style>",
    ""
  ].join("\n")

test("rejects counting the tags or the script and template as style block lines", () => {
  expect(styleBlocksOf(component(3))).toEqual([{ line: 9, lines: 3 }])
})

test("rejects a style block of exactly 400 lines failing the budget", () => {
  expect(failuresOf("Card.vue", component(400))).toEqual([])
})

test("rejects a style block of 401 lines passing the budget", () => {
  expect(failuresOf("Card.vue", component(401))).toEqual([
    "Card.vue:9: style block of 401 lines, over the 400-line budget; move it into a stylesheet file"
  ])
})

test("rejects judging two style blocks as one", () => {
  const source = ["<template><p>Hi</p></template>", "<style>", "a { color: red; }", "</style>", "<style scoped>", "b { color: red; }", "i { color: red; }", "</style>", ""].join("\n")
  expect(styleBlocksOf(source)).toEqual([{ line: 2, lines: 1 }, { line: 5, lines: 2 }])
})

test("rejects counting a one-line style block as more lines than it holds", () => {
  expect(styleBlocksOf("<template><p>Hi</p></template>\n<style>a { color: red; }</style>\n")).toEqual([{ line: 2, lines: 1 }])
})
