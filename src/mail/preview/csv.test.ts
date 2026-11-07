import { expect, test } from "vitest";
import { parseDelimited } from "./csv";

test("quoted fields keep commas, doubled quotes and line breaks", () => {
  const text = 'Name,Notes\r\nMira,"Brings the urn, ""the big one"""\nTom,"two\nlines"\n';
  expect(parseDelimited(text, "a.csv")).toEqual([
    ["Name", "Notes"],
    ["Mira", 'Brings the urn, "the big one"'],
    ["Tom", "two\nlines"],
  ]);
});

test("tabs and semicolons are detected; a byte-order mark is dropped", () => {
  expect(parseDelimited("a\tb\n1\t2", null)).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  expect(parseDelimited("﻿a;b\n1;2", "export.csv")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  expect(parseDelimited("a,b\n", "x.tsv")).toEqual([["a,b"]]);
});
