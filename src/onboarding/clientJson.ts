/** Accepts the JSON file Google offers when a client is created, pasted whole. */
export type ParsedClient =
  | { ok: true; clientId: string; clientSecret: string }
  | { ok: false; reason: string };

export function parseClientJson(text: string): ParsedClient | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const root = json as Record<string, { client_id?: unknown; client_secret?: unknown } | undefined>;
  if (root.web) {
    return {
      ok: false,
      reason:
        "That's a Web application client. Create a client with application type Desktop app instead.",
    };
  }
  const client = root.installed;
  if (typeof client?.client_id === "string" && typeof client.client_secret === "string") {
    return { ok: true, clientId: client.client_id, clientSecret: client.client_secret };
  }
  return { ok: false, reason: "That JSON doesn't contain a client ID and secret." };
}
