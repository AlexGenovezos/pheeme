/**
 * The files a paste carries when it is only files, such as a screenshot copied to the clipboard. A paste with
 * text keeps its text: apps like Word put a picture of the copied text beside it, and that isn't an attachment.
 */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data || data.files.length === 0) return [];
  if (data.getData("text/plain").trim() !== "") return [];
  return [...data.files];
}
