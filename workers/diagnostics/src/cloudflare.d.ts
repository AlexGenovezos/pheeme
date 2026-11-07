// Ambient declarations for the two Workers runtime modules index.ts imports,
// covering only what it uses (no @cloudflare/workers-types dependency).

declare module "cloudflare:email" {
  /** A raw RFC 5322 message for a `send_email` binding. */
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
    readonly from: string;
    readonly to: string;
  }
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: {
      storage: {
        get<T>(key: string): Promise<T | undefined>;
        put(key: string, value: unknown): Promise<void>;
      };
    };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
