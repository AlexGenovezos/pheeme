import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    invoke<string>("greet", { name: "world" })
      .then(() => setReady(true))
      .catch((err) => console.error("greet failed", err));
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "sans-serif" }}>
      {ready ? <h2>Pheeme — ready</h2> : <p>Loading...</p>}
    </div>
  );
}

export default App;
