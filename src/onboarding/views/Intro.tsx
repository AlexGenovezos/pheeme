import { Lock, RefreshCw, Wallet } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { openExternal } from "../../lib/tauri";
import { TELEMETRY_TITLE, TelemetrySwitch } from "../../settings/telemetry";
import { INTRO } from "../steps";

const INTRO_ICONS = [Wallet, Lock, RefreshCw];

/** First-run welcome: why setup asks for your own Google Cloud app, before the guide starts. */
export function Intro({ onStart, onReceive }: { onStart: () => void; onReceive: () => void }) {
  const icon = `${import.meta.env.BASE_URL}pheeme-icon.png`;
  return (
    <main className="intro">
      <div className="intro__backdrop" aria-hidden>
        <img src={icon} alt="" />
      </div>
      <div className="intro__art">
        <img src={icon} alt="" />
      </div>
      <div className="intro__copy">
        <p className="intro__eyebrow">{INTRO.eyebrow}</p>
        <h1>{INTRO.title}</h1>
        <p className="intro__lead">{INTRO.lead}</p>
        <ul className="intro__points">
          {INTRO.points.map((point, index) => {
            const Icon = INTRO_ICONS[index];
            return (
              <li key={point.title}>
                <span className="intro__icon" aria-hidden>
                  <Icon />
                </span>
                <div>
                  <strong>{point.title}</strong>
                  <p>{point.body}</p>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="intro__actions">
          <Button variant="primary" size="lg" onClick={onStart}>
            Set up my Google app
          </Button>
          <Button size="lg" onClick={onReceive}>
            Receive from another device
          </Button>
        </div>
        <div className="intro__telemetry">
          <strong>{TELEMETRY_TITLE}</strong>
          <TelemetrySwitch />
          <p>{INTRO.telemetry}</p>
        </div>
        <p className="intro__fine">
          Pheeme is open source under the MIT license.{" "}
          <button
            type="button"
            className="link"
            onClick={() => void openExternal(INTRO.guideUrl).catch(() => {})}
          >
            How this works
          </button>
        </p>
      </div>
    </main>
  );
}
