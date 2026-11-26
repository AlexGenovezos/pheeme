import { CalendarDays } from "lucide-react";
import { OtherZonesControl } from "../../calendar/OtherZonesControl";
import { TemplateSettings, templatesMatch } from "../../calendar/TemplateSettings";
import {
  AnimateWeatherControl,
  HomeLocationControl,
  ShowWeatherControl,
  TemperatureUnitControl,
} from "../../weather/WeatherControls";
import type { SettingsPageDef } from "../schema";

export const CALENDAR_PAGE: SettingsPageDef = {
  id: "calendar",
  title: "Calendar",
  icon: CalendarDays,
  group: "Calendar",
  keywords: ["weather", "forecast", "temperature", "time zones", "templates"],
  sections: [
    {
      title: "Time zones",
      settings: [
        {
          id: "calendar.otherZones",
          title: "Other time zones",
          description:
            "Up to two. Day and Week show their hours beside your calendar's, and an event's popover shows its time in each. A short label replaces the zone's name over its hours. To convert a time, type it in the command palette, like “3pm PT in Athens”.",
          keywords: ["timezone", "world clock", "second", "travel", "convert", "converter", "city"],
          Control: OtherZonesControl,
        },
      ],
    },
    {
      id: "eventTemplates",
      Component: TemplateSettings,
      keywords: ["templates", "event templates", "reuse", "presets", "quick add"],
      matches: templatesMatch,
    },
    {
      title: "Weather",
      settings: [
        {
          id: "weather.show",
          title: "Show weather",
          description:
            "The forecast at the top of each day, and for an event's place when you open it. To get it, Pheeme sends your home location and those places to Open-Meteo (open-meteo.com), and nothing else. Weather data by Open-Meteo.com, CC BY 4.0.",
          keywords: ["forecast", "open-meteo", "privacy", "location"],
          Control: ShowWeatherControl,
        },
        {
          id: "weather.home",
          title: "Home location",
          description:
            "The town whose forecast the days show. Type it, or find it from your calendar's time zone.",
          keywords: ["weather", "city", "town", "location", "detect"],
          Control: HomeLocationControl,
        },
        {
          id: "weather.unit",
          title: "Temperature",
          keywords: ["weather", "fahrenheit", "celsius", "units"],
          Control: TemperatureUnitControl,
        },
        {
          id: "weather.animate",
          title: "Animate weather",
          description:
            "The drawings move in an event's popover, and on the day you point at. Off, they hold still. Reduce motion in your system settings holds them still too.",
          keywords: ["weather", "animation", "motion", "moving", "still"],
          Control: AnimateWeatherControl,
        },
      ],
    },
  ],
};
