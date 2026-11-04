/** Public mod API 1. Include this file in a mod author's TypeScript project. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Control =
  | { type: "text"; text: string }
  | { type: "button"; id: string; label: string; disabled?: boolean }
  | { type: "toggle"; id: string; label: string; value: boolean }
  | { type: "input"; id: string; label: string; value: string };

export interface ModApi {
  readonly apiVersion: 1;
  /** IDs are local to the mod. Values are null for commands/buttons, booleans for toggles, strings for inputs. */
  on(id: string, handler: (value: Json) => void | Promise<void>): () => void;
  render(surface: "settings" | "panel" | "compact", blocks: Control[]): Promise<void>;
  storage: {
    get(key: string): Promise<Json>;
    set(key: string, value: Json): Promise<void>;
  };
  http: {
    /** Redirects are returned, never followed. Parse body with JSON.parse if needed. */
    request(request: {
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: string;
      contentType?: "application/json" | "application/x-www-form-urlencoded" | "text/plain";
      /** A declared connection ID, scoped to this mod. Tokens remain in the host. */
      connection?: string;
    }): Promise<{ status: number; body: string }>;
  };
  connections: {
    /** Login/disconnect happen through Pheeme's settings, not from background code. */
    status(id: string): Promise<{ connected: boolean }>;
  };
  /** At most 8 timers, interval >= 1000ms. Timers stop when the mod stops or Pheeme quits. */
  every(ms: number, handler: () => void | Promise<void>): () => void;
}

declare global {
  const pheeme: ModApi;
}
