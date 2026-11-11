import { Bell } from "lucide-react";
import { Button } from "../components/ui/Button";
import { answerNotificationOffer, useNotificationOffer } from "./prompt";
import "./desktop.css";

/** The first-run notifications offer, at the foot of the sidebar (mail and calendar alike). */
export function NotificationOffer() {
  const offer = useNotificationOffer((s) => s.offer);
  if (!offer) return null;
  return (
    <section className="notify-offer" aria-labelledby="notify-offer-title">
      <div className="notify-offer__text">
        <Bell aria-hidden="true" />
        <div>
          <h2 id="notify-offer-title" className="notify-offer__title">
            Turn on notifications?
          </h2>
          <p className="notify-offer__description">{offer}</p>
        </div>
      </div>
      <div className="notify-offer__actions">
        <Button size="sm" onClick={() => void answerNotificationOffer(false)}>
          Not now
        </Button>
        <Button size="sm" variant="primary" onClick={() => void answerNotificationOffer(true)}>
          Turn on
        </Button>
      </div>
    </section>
  );
}
