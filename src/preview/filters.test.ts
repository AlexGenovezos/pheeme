import { expect, test, vi } from "vitest";
import { EMPTY_SPEC } from "../filters/form";
import type { FixtureThread } from "./fixtures";
import { createFilterHandlers } from "./filters";
import type { PreviewLabel } from "./labels";

const thread = (id: string, from: string, subject: string, labelIds: string[]): FixtureThread =>
  ({
    id,
    accountId: "acc-personal",
    labelIds,
    subject,
    messages: [{ fromAddress: from, bodyText: "hello", unread: true }],
  }) as unknown as FixtureThread;

function setup(missingScope = false) {
  const threads = [
    thread("t1", "news@x.com", "Sale", ["INBOX"]),
    thread("t2", "news@x.com", "More", ["INBOX"]),
    thread("t3", "friend@y.com", "Hi", ["INBOX"]),
  ];
  const labels = [{ id: "Label_1", accountId: "acc-personal", name: "Receipts" } as PreviewLabel];
  const changed: string[][] = [];
  const changeThreads = vi.fn(
    (args: { accountId: string; threadIds: string[] }, change: (t: FixtureThread) => void) => {
      changed.push(args.threadIds);
      threads.filter((t) => args.threadIds.includes(t.id)).forEach(change);
    },
  );
  const h = createFilterHandlers(threads, labels, missingScope, changeThreads);
  return { h, threads, changed };
}

const account = { accountId: "acc-personal" };
const spec = { ...EMPTY_SPEC, from: "news@x.com", skipInbox: true, star: true, label: "Label_1" };

test("the preview's filters start seeded and say what they do in words", () => {
  const { h } = setup();
  const list = h.list_filters(account);
  expect(list.map((f) => f.matches)).toEqual([
    "from:receipts@shop.example",
    "subject:Lisbon has:attachment",
  ]);
  expect(list[0].actions).toEqual(["apply label Receipts", "skip the inbox (archive it)"]);
  expect(h.forwarding_addresses(account)).toEqual(["avery.archive@example.net"]);
  expect(h.forwarding_addresses({ accountId: "acc-work" })).toEqual([]);
});

test("create, apply to existing mail, edit and delete, as the backend does", () => {
  const { h, threads, changed } = setup();
  expect(h.filter_matches({ ...account, spec })).toBe(2);

  const saved = h.create_filter({ ...account, spec, applyToExisting: true });
  expect(saved.applyError).toBeNull();
  expect(saved.filter.matches).toBe("from:news@x.com");
  expect(changed).toEqual([["t1", "t2"]]);
  expect(threads[0].labelIds).toEqual(["Label_1", "STARRED"]);
  expect(threads[2].labelIds).toEqual(["INBOX"]);
  expect(() => h.create_filter({ ...account, spec, applyToExisting: false })).toThrow();

  const edited = h.replace_filter({
    ...account,
    filterId: saved.filter.id,
    spec: { ...spec, markRead: true, trash: true, important: false, excludeChats: true },
    applyToExisting: true,
  });
  expect(edited.filter.id).not.toBe(saved.filter.id);
  expect(edited.filter.matches).toBe("from:news@x.com -in:chats");
  expect(edited.filter.actions).toContain("never mark it important");
  expect(threads[0].labelIds).toContain("TRASH");
  expect(threads[0].messages[0].unread).toBe(false);
  expect(() =>
    h.replace_filter({ ...account, filterId: "gone", spec, applyToExisting: false }),
  ).toThrow();

  h.delete_filter({ ...account, filterId: edited.filter.id });
  expect(h.list_filters(account)).toHaveLength(2);
  expect(() => h.delete_filter({ ...account, filterId: edited.filter.id })).toThrow();
});

test("the preview refuses what the backend would", () => {
  const { h } = setup();
  const refused = (s: typeof spec) => {
    try {
      h.create_filter({ ...account, spec: s, applyToExisting: false });
    } catch (e) {
      return (e as { message: string }).message;
    }
    return null;
  };
  expect(refused({ ...EMPTY_SPEC, star: true } as typeof spec)).toMatch(/search option/);
  expect(refused({ ...EMPTY_SPEC, from: "a@x.com" } as typeof spec)).toMatch(/thing to do/);
  expect(refused({ ...spec, size: 5 } as typeof spec)).toMatch(/greater than/);
  expect(refused({ ...spec, size: 0, sizeComparison: "larger" } as typeof spec)).toMatch(/zero/);
  // Counting needs only search options.
  expect(h.filter_matches({ ...account, spec: { ...EMPTY_SPEC, from: "news@x.com" } })).toBe(2);
});

test("without filters access every Gmail call says so", () => {
  const { h } = setup(true);
  expect(() => h.list_filters(account)).toThrow(expect.objectContaining({ code: "missing_scope" }));
  expect(() => h.forwarding_addresses(account)).toThrow();
  expect(() => h.delete_filter({ ...account, filterId: "x" })).toThrow();
});
