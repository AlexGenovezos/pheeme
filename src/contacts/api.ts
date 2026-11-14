import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent } from "../lib/tauri";

export interface PersonProfile {
  address: string;
  name: string | null;
  saved: boolean;
  conversations: { id: string; subject: string | null; snippet: string | null; date: number }[];
  events: CalendarEvent[];
  calendarAvailable: boolean;
}

export const personProfile = (accountId: string, address: string, displayTz: string) =>
  invoke<PersonProfile>("person_profile", { accountId, address, displayTz });

export const savePersonContact = (accountId: string, address: string, name: string | null) =>
  invoke<void>("save_person_contact", { accountId, address, name });
