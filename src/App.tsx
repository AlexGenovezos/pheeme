import { useEffect, useState } from "react";
import { AccountsHome } from "./components/AccountsHome";
import { UpdateBanner } from "./components/UpdateBanner";
import { startUpdateChecks } from "./lib/updater";
import { Onboarding } from "./onboarding/Onboarding";
import { useAccountStore } from "./store/accountStore";

function App() {
  const { accounts, loaded, error, load, upsert } = useAccountStore();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (import.meta.env.PROD) return startUpdateChecks();
  }, []);

  let screen = null; // The account list is local and fast: render nothing rather than flash a loader.
  if (loaded && error) {
    screen = (
      <div className="onboarding onboarding--single">
        <main className="onboarding-main">
          <div className="onboarding-content" role="alert">
            <h1>Pheeme couldn't start</h1>
            <p className="guide-lead">{error.message}</p>
          </div>
        </main>
      </div>
    );
  } else if (loaded && (accounts.length === 0 || adding)) {
    screen = (
      <Onboarding
        accounts={accounts}
        onConnected={(account) => {
          upsert(account);
          setAdding(false);
        }}
        onClose={accounts.length > 0 ? () => setAdding(false) : undefined}
      />
    );
  } else if (loaded) {
    screen = <AccountsHome onAdd={() => setAdding(true)} />;
  }

  return (
    <>
      <UpdateBanner />
      {screen}
    </>
  );
}

export default App;
