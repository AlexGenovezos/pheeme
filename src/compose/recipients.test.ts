import { expect, test } from "vitest";
import {
  addRecipients,
  formatRecipient,
  isValidAddress,
  parseRecipient,
  parseRecipients,
} from "./recipients";

test("reads names and addresses in the usual shapes", () => {
  expect(parseRecipient("Mira Okafor <mira@example.com>")).toEqual({
    name: "Mira Okafor",
    address: "mira@example.com",
  });
  expect(parseRecipient('"Okafor, Mira" <mira@example.com>')).toEqual({
    name: "Okafor, Mira",
    address: "mira@example.com",
  });
  expect(parseRecipient("<bo@x.test>")).toEqual({ name: null, address: "bo@x.test" });
  expect(parseRecipient("mailto:bo@x.test")).toEqual({ name: null, address: "bo@x.test" });
});

test("splits on commas, semicolons and lines, but not inside quotes or brackets", () => {
  expect(
    parseRecipients('"Okafor, Mira" <mira@example.com>; bo@x.test,\ncy@x.test').map(
      (r) => r.address,
    ),
  ).toEqual(["mira@example.com", "bo@x.test", "cy@x.test"]);
  expect(parseRecipients("a@x.test b@x.test").map((r) => r.address)).toEqual([
    "a@x.test",
    "b@x.test",
  ]);
  expect(parseRecipients(" , ;")).toEqual([]);
});

test("validates addresses", () => {
  expect(isValidAddress("a@b.co")).toBe(true);
  expect(isValidAddress("a@b")).toBe(false);
  expect(isValidAddress("not an address")).toBe(false);
  expect(isValidAddress("a b@c.d")).toBe(false);
});

test("adding skips addresses already there, whatever their case", () => {
  const list = [{ name: null, address: "Mira@Example.com" }];
  expect(
    addRecipients(list, [
      { name: "Mira", address: "mira@example.com" },
      { name: null, address: "bo@x.test" },
    ]),
  ).toEqual([list[0], { name: null, address: "bo@x.test" }]);
});

test("formats a chip back into editable text", () => {
  expect(formatRecipient({ name: "Mira", address: "m@x.test" })).toBe("Mira <m@x.test>");
  expect(formatRecipient({ name: null, address: "m@x.test" })).toBe("m@x.test");
});
