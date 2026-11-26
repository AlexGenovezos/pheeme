import { BookOpen } from "lucide-react";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { type PrintScope, usePrintSettings } from "../../mail/printSettings";
import {
  OfferControl,
  PausesControl,
  SpeedControl,
  WordSizeControl,
} from "../../speedread/SpeedReader";
import { READING_SIZES, type ReadingSize, useReadingSettings } from "../readingSettings";
import type { SettingsPageDef } from "../schema";

function PreloadImagesControl() {
  const checked = useReadingSettings((s) => s.preloadImages);
  const onChange = useReadingSettings((s) => s.setPreloadImages);
  return <Switch label="Preload images" checked={checked} onChange={onChange} />;
}

function ReadingSizeControl() {
  const size = useReadingSettings((s) => s.size);
  const setSize = useReadingSettings((s) => s.setSize);
  return (
    <SegmentedControl
      label="Reading text size"
      value={size}
      options={READING_SIZES.map((value) => ({
        value,
        label: value === "large" ? "Large" : "Standard",
      }))}
      onChange={(value) => setSize(value as ReadingSize)}
    />
  );
}

function PrintScopeControl() {
  const scope = usePrintSettings((s) => s.scope);
  const setScope = usePrintSettings((s) => s.setScope);
  return (
    <SegmentedControl
      label="What Print prints"
      value={scope}
      options={[
        { value: "conversation", label: "Whole conversation" },
        { value: "message", label: "Latest message" },
      ]}
      onChange={(value) => setScope(value as PrintScope)}
    />
  );
}

export const READING_PAGE: SettingsPageDef = {
  id: "reading",
  title: "Reading",
  icon: BookOpen,
  keywords: ["text", "font", "images"],
  sections: [
    {
      title: "Messages",
      settings: [
        {
          id: "reading.size",
          title: "Text size",
          description: "For plain-text messages and the messages you write.",
          keywords: ["font", "larger", "accessibility", "compose", "zoom"],
          Control: ReadingSizeControl,
        },
        {
          id: "reading.preloadImages",
          title: "Preload images",
          description:
            "Preloading images lets senders see that an email was opened, along with your IP address and approximate location, even for emails you skip. Turning it off keeps text preloading, and loads images only when you open an email.",
          keywords: ["privacy", "images", "tracking"],
          Control: PreloadImagesControl,
        },
      ],
    },
    {
      title: "Printing",
      settings: [
        {
          id: "reading.printScope",
          title: "Print",
          description:
            "What Print in the More menu, and its shortcut, prints. Each message's printer button prints just that message.",
          keywords: ["printer", "paper", "pdf", "conversation", "message"],
          Control: PrintScopeControl,
        },
      ],
    },
    {
      title: "Speed reader",
      settings: [
        {
          id: "speedReader.offer",
          title: "Offer speed reading",
          description:
            "Show a Speed read button on emails that are mostly plain text, to read them one word at a time.",
          keywords: ["rsvp", "fast", "reader", "words"],
          Control: OfferControl,
        },
        {
          id: "speedReader.wpm",
          title: "Speed",
          description: "Words per minute. You can also change it while reading.",
          keywords: ["wpm", "words per minute", "fast", "slow", "speed reader"],
          Control: SpeedControl,
        },
        {
          id: "speedReader.pauses",
          title: "Pause at punctuation",
          description: "Linger a moment at commas, the ends of sentences and new paragraphs.",
          keywords: ["speed reader", "commas", "sentences"],
          Control: PausesControl,
        },
        {
          id: "speedReader.size",
          title: "Word size",
          description: "How big each word shows in the speed reader.",
          keywords: ["speed reader", "font", "larger"],
          Control: WordSizeControl,
        },
      ],
    },
  ],
};
