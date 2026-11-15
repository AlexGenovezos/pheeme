import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent } from "../lib/tauri";

export interface PersonProfile {
  address: string;
  name: string | null;
  saved: boolean;
  /** From Google Contacts. */
  phone: string | null;
  organization: string | null;
  photoUrl: string | null;
  conversations: { id: string; subject: string | null; snippet: string | null; date: number }[];
  /** Meetings together in the next 90 days, soonest first. */
  events: CalendarEvent[];
  /** Meetings together in the last 180 days, newest first. */
  pastEvents: CalendarEvent[];
  calendarAvailable: boolean;
}

export const personProfile = (accountId: string, address: string, displayTz: string) =>
  invoke<PersonProfile>("person_profile", { accountId, address, displayTz });

export const savePersonContact = (accountId: string, address: string, name: string | null) =>
  invoke<void>("save_person_contact", { accountId, address, name });
