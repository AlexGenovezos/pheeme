import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/global.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { platform } from "./lib/platform";
import { isPreview, isTauri } from "./preview/runtime";
import { syncNativeWindow } from "./theme/nativeWindow";
import { initTheme } from "./theme/theme";

const root = document.documentElement;
root.dataset.platform = platform;
root.dataset.runtime = isTauri() ? "tauri" : "browser";

// Theme tokens land on :root before the first React render, so nothing paints unthemed.
initTheme(isTauri() ? syncNativeWindow : undefined);

function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

if (isPreview()) {
  // Plain browser: answer IPC from fixtures. Loaded lazily so the desktop bundle skips it.
  import("./preview/install")
    .then(({ installPreview }) => installPreview())
    .catch((err) => console.error("preview mode failed to start", err))
    .finally(render);
} else {
  render();
}
