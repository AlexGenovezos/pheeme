// This bundled script runs in Pheeme's isolated JavaScript runtime.
let count = 0;
let title = "My counter";
let showCompact = true;

async function render() {
  await pheeme.render("settings", [
    { type: "input", id: "title", label: "Counter name", value: title },
    { type: "toggle", id: "compact", label: "Show count in sidebar", value: showCompact },
    { type: "button", id: "reset", label: "Reset counter" },
  ]);
  await pheeme.render("panel", [
    { type: "text", text: `${title}: ${count}` },
    { type: "button", id: "increment", label: "Add one" },
  ]);
  await pheeme.render(
    "compact",
    showCompact
      ? [
          { type: "text", text: `${title}: ${count}` },
          { type: "button", id: "increment", label: "+1" },
        ]
      : [],
  );
}

pheeme.on("increment", async () => {
  count += 1;
  await pheeme.storage.set("count", count);
  await render();
});
pheeme.on("reset", async () => {
  count = 0;
  await pheeme.storage.set("count", count);
  await render();
});
pheeme.on("title", async (value) => {
  title = String(value).slice(0, 100);
  await pheeme.storage.set("title", title);
  await render();
});
pheeme.on("compact", async (value) => {
  showCompact = value === true;
  await pheeme.storage.set("compact", showCompact);
  await render();
});

(async () => {
  count = Number(await pheeme.storage.get("count")) || 0;
  title = (await pheeme.storage.get("title")) || title;
  showCompact = (await pheeme.storage.get("compact")) !== false;
  await render();
})();
