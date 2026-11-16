import { call } from "./call";

/** A file in the themes folder (`{app data}/themes`), unparsed. */
export interface ThemeFolderFile {
  name: string;
  text: string;
}
export const listThemeFolder = () => call("list_theme_folder");
export const openThemeFolder = () => call("open_theme_folder");
/** What `clearDownloadedMail` removed: emails whose text went, and bytes of attachments. */
export interface ClearedDownloads {
  messages: number;
  bytes: number;
}
/** Drops every downloaded email body (except drafts) and cached attachment, for all accounts. */
export const clearDownloadedMail = () => call("clear_downloaded_mail");
