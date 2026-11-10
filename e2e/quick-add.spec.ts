import { expect, test } from "@playwright/test";

test("quick add highlights the words it read, each under its own text", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("radio", { name: "Calendar" }).click();
  await page.getByRole("button", { name: /^Create/ }).click();
  const dialog = page.getByRole("dialog", { name: "Quick add" });
  const input = dialog.getByRole("textbox", { name: "Event, in words" });
  await input.fill("Lunch with Grace Friday at noon at Joe's /team");

  await expect(dialog.getByText("Lunch with Grace", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Joe's", { exact: true })).toBeVisible();
  // "Grace" offers the matching contacts; nobody is invited until one is picked.
  const who = dialog.getByRole("combobox", { name: "Who Grace is" });
  await expect(who.getByRole("option", { name: /Grace Hopper/ })).toBeAttached();
  await expect(who).toHaveValue("");
  await who.selectOption({ label: "Grace Hopper <grace@example.net>" });
  await testInfo.attach("quick-add", { body: await dialog.screenshot(), contentType: "image/png" });

  // Each mark starts where its words start in the field: the width of the text before it.
  const offsets = await dialog.evaluate((el) => {
    const field = el.querySelector<HTMLInputElement>(".cal-qa__input")!;
    const ctx = document.createElement("canvas").getContext("2d")!;
    const style = getComputedStyle(field);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const left = field.getBoundingClientRect().left;
    let at = 0;
    return [...el.querySelectorAll<HTMLElement>(".cal-qa__mark")].map((mark) => {
      const index = field.value.indexOf(mark.textContent!, at);
      at = index + mark.textContent!.length;
      return {
        text: mark.textContent,
        mark: mark.getBoundingClientRect().left - left,
        text_: ctx.measureText(field.value.slice(0, index)).width,
      };
    });
  });
  expect(offsets.map((o) => o.text)).toEqual(["Grace", "Friday at noon", "at Joe's", "/team"]);
  for (const o of offsets) expect(Math.abs(o.mark - o.text_)).toBeLessThan(1.5);
});
