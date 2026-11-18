import { expect, test } from "vitest";
import { EMPTY_FORM, fromForm, invalidFields, toForm } from "./searchForm";
import { hasTerm, labelValue, suggest, terms, toggleTerm } from "./operators";

test("terms keep phrases, quoted values and groups whole", () => {
  expect(
    terms(
      'invoice "board meeting" from:"Amy Smith" -is:starred subject:(a b) {x y} header:X-A:b',
    ).map((t) => [t.raw, t.key, t.value, t.negated]),
  ).toEqual([
    ["invoice", null, "invoice", false],
    ['"board meeting"', null, "board meeting", false],
    ['from:"Amy Smith"', "from", "Amy Smith", false],
    ["-is:starred", "is", "starred", true],
    ["subject:(a b)", "subject", "(a b)", false],
    ["{x y}", null, "{x y}", false],
    ["header:X-A:b", "header", "X-A:b", false],
  ]);
  expect(terms("re:meeting 10:30 -")[0].key).toBeNull();
});

test("a term toggles without touching the rest of the query", () => {
  expect(hasTerm("invoice IS:Unread", "is", "unread")).toBe(true);
  expect(hasTerm("-is:unread", "is", "unread")).toBe(false);
  expect(toggleTerm("invoice", "is", "unread", true)).toBe("invoice is:unread");
  expect(toggleTerm("is:unread invoice -is:unread", "is", "unread", false)).toBe(
    "invoice -is:unread",
  );
});

test("operators are suggested for the word being typed, values once the key is there", () => {
  expect(suggest("invoice ha", 10, []).items.map((s) => s.insert)).toEqual(["has:"]);
  expect(suggest("invoice ha", 10, []).start).toBe(8);
  expect(suggest("i", 1, []).items).toEqual([]);
  expect(suggest("in", 2, []).items.map((s) => s.insert)).toEqual(["in:"]);
  // Only at the end of a word.
  expect(suggest("has invoice", 2, []).items).toEqual([]);
  expect(suggest("-is:st", 6, []).items.map((s) => s.insert)).toEqual(["is:starred "]);
  expect(suggest("-is:st", 6, []).start).toBe(1);
  expect(suggest("has:", 4, []).items.length).toBe(12);
  expect(suggest("has:yellow", 10, []).items.map((s) => s.label)).toEqual([
    "has:yellow-star",
    "has:yellow-bang",
  ]);
  expect(suggest("is:unread", 9, []).items).toEqual([]);
  expect(
    suggest("label:pr", 8, ["Projects/Q3 plan", "Personal"]).items.map((s) => s.insert),
  ).toEqual(["label:Projects-Q3-plan "]);
  expect(labelValue(" Work / Clients ")).toBe("Work-Clients");
});

test("the form reads each operator into its field and writes the same search back", () => {
  const query =
    'from:amy to:me cc:carl bcc:dee subject:"q3 plan" invoice receipt -draft -"old news" ' +
    "in:sent category:updates is:unread is:muted has:attachment has:drive has:red-bang " +
    "filename:pdf list:team@example.com deliveredto:me@example.com after:2026/01/05 " +
    "before:02/01/2026 newer_than:2m older_than:7d smaller:500k rfc822msgid:abc@x header:X-A:b";
  const form = toForm(query);
  expect(form).toEqual({
    ...EMPTY_FORM,
    from: "amy",
    to: "me",
    cc: "carl",
    bcc: "dee",
    subject: '"q3 plan"',
    words: "invoice receipt",
    exclude: 'draft "old news"',
    mailbox: "in:sent",
    category: "updates",
    is: ["unread", "muted"],
    has: ["attachment", "drive"],
    star: "red-bang",
    filename: "pdf",
    list: "team@example.com",
    deliveredto: "me@example.com",
    after: "2026-01-05",
    before: "2026-02-01",
    newer: "2",
    newerUnit: "m",
    older: "7",
    olderUnit: "d",
    sizeOp: "smaller",
    size: "500",
    sizeUnit: "K",
    messageId: "abc@x",
    header: "X-A:b",
  });
  expect(fromForm(form)).toBe(
    'from:amy to:me cc:carl bcc:dee subject:"q3 plan" invoice receipt -draft -"old news" ' +
      "in:sent category:updates is:unread is:muted has:attachment has:drive has:red-bang " +
      "filename:pdf list:team@example.com deliveredto:me@example.com after:2026/01/05 " +
      "before:2026/02/01 newer_than:2m older_than:7d smaller:500K rfc822msgid:abc@x header:X-A:b",
  );
});

test("terms without a free field stay in Has the words as written", () => {
  const form = toForm("from:a from:b -is:starred in:nowhere label:Work in:inbox after:yesterday");
  expect(form.from).toBe("a");
  expect(form.mailbox).toBe("label:Work");
  expect(form.words).toBe("from:b -is:starred in:nowhere in:inbox after:yesterday");
  expect(toForm("").words).toBe("");
  expect(fromForm(EMPTY_FORM)).toBe("");
  expect(fromForm({ ...EMPTY_FORM, size: "big", newer: "soon" })).toBe("");
  expect(invalidFields({ ...EMPTY_FORM, size: "big", newer: "7d", older: "1.5" })).toEqual([
    "newer",
    "older",
    "size",
  ]);
  expect(invalidFields({ ...EMPTY_FORM, size: "2.5", newer: " 7 " })).toEqual([]);
  expect(fromForm({ ...EMPTY_FORM, newer: "4", older: "3", olderUnit: "y" })).toBe(
    "newer_than:4d older_than:3y",
  );
});

test("the form keeps OR, AROUND and quoted values as Gmail reads them", () => {
  expect(toForm(" from:a  OR   from:b ").words).toBe("from:a  OR   from:b");
  for (const query of ["invoice OR from:alice", "holiday AROUND 10 from:amy"]) {
    const form = toForm(query);
    expect(form).toEqual({ ...EMPTY_FORM, words: query });
    expect(fromForm(form)).toBe(query);
  }
  const quoted = toForm('subject:"invoice" from:"me" is:"unread"');
  expect([quoted.subject, quoted.from, quoted.is, quoted.words]).toEqual([
    '"invoice"',
    '"me"',
    [],
    'is:"unread"',
  ]);
  expect(fromForm(quoted)).toBe('from:"me" subject:"invoice" is:"unread"');
});

test("Unread only only counts an is:unread that stands alone", () => {
  expect(hasTerm("invoice OR is:unread", "is", "unread")).toBe(false);
  expect(toggleTerm("invoice OR is:unread", "is", "unread", false)).toBe("invoice OR is:unread");
  expect(toggleTerm("invoice OR is:unread", "is", "unread", true)).toBe(
    "invoice OR is:unread is:unread",
  );
  expect(hasTerm('is:"unread"', "is", "unread")).toBe(false);
  expect(hasTerm("invoice AND is:unread", "is", "unread")).toBe(true);
  expect(toggleTerm("invoice AND is:unread", "is", "unread", false)).toBe("invoice");
  expect(toggleTerm("is:unread AND invoice", "is", "unread", false)).toBe("invoice");
});

test("nothing is suggested inside a quoted phrase", () => {
  expect(suggest('subject:"log in', 15, []).items).toEqual([]);
  expect(suggest('subject:"log" in', 16, []).items.map((s) => s.insert)).toEqual(["in:"]);
});
