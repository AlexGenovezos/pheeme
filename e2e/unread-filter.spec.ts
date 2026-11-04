import { expect, test } from "@playwright/test";

test("unread filtering survives reading and mailbox changes, and stays separate from search", async ({
  page,
}) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Unread only", exact: true });
  const rows = page.getByRole("listbox", { name: "All Inboxes conversations" }).getByRole("option");
  const statement = rows.filter({ hasText: "Your October statement is ready" });
  const icon = rows.filter({ hasText: "Icon sketches for the dock" });
  await expect(statement).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: "test-results/unread-before.png" });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(statement).toHaveCount(0);
  expect(
    await rows.evaluateAll((elements) =>
      elements.every((element) => element.getAttribute("data-unread") === "true"),
    ),
  ).toBe(true);
  const filteredCount = await rows.count();
  await expect(icon).toBeVisible();
  await page.screenshot({ path: "test-results/unread-after.png" });

  // Opening marks it read and emits a sync; it must stay where the reader opened it.
  await icon.click();
  await expect(icon).not.toHaveAttribute("data-unread", "true");
  await expect(rows).toHaveCount(filteredCount);
  await expect(icon).toBeVisible();

  // Undoing another row's archive must not clear this visit's just-read row.
  const other = rows.filter({ hasText: "Pilot for the support team" });
  await other.hover();
  await other.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(other).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(other).toBeVisible();
  await expect(icon).toBeVisible();
  await expect(rows).toHaveCount(filteredCount);

  const navigation = page.getByRole("navigation", { name: "Mailboxes" });
  await navigation.getByRole("link", { name: "Starred", exact: true }).first().click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await navigation.getByRole("link", { name: "All Inboxes", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(icon).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search mail" }).fill("statement");
  await expect(toggle).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(statement).toHaveCount(0);
  await toggle.click();
  await expect(statement).toBeVisible();
});
