import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { startUpdateChecks } from "./lib/updater";

function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    invoke<string>("greet", { name: "world" })
      .then(() => setReady(true))
      .catch((err) => console.error("greet failed", err));
  }, []);

  useEffect(() => {
    if (import.meta.env.PROD) return startUpdateChecks();
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "sans-serif" }}>
      <UpdateBanner />
      {ready ? <h2>Pheeme — ready</h2> : <p>Loading...</p>}
    </div>
  );
}

export default App;
