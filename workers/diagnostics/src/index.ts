// Entry point: wires the real Cloudflare bindings into the pure handler.
// Tests import handler.ts and mime.ts, never this file.

import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { handleUpload, takeDailySlot } from "./handler";
import { buildMime } from "./mime";
import type { Env } from "./types";

const FROM = "diagnostics@pheeme.email";
// Must match `destination_address` of the NOTIFY binding in wrangler.jsonc.
const TO = "ajg0360@gmail.com";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleUpload(request, {
      bucket: env.BUNDLES,
      perIp: env.PER_IP,
      dailyCap: env.DAILY_CAP.getByName("global"),
      now: () => new Date(),
      id: () => crypto.randomUUID(),
      notify: async (mail) => {
        const raw = buildMime({
          from: FROM,
          fromName: "Pheeme diagnostics",
          to: TO,
          replyTo: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          messageId: `<${crypto.randomUUID()}@pheeme.email>`,
          date: new Date(),
        });
        await env.NOTIFY.send(new EmailMessage(FROM, TO, raw));
      },
    });
  },
};

/** One instance (named "global") counts accepted uploads per UTC day. */
export class DailyCap extends DurableObject<Env> {
  async take(): Promise<boolean> {
    return takeDailySlot(this.ctx.storage, new Date());
  }
}
