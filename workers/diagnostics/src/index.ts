// Entry point: wires the real Cloudflare bindings into the pure handler.
// Tests import handler.ts and mime.ts, never this file.

import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { handleUpload, takeDailySlot } from "./handler";
import { buildMime } from "./mime";
import { handlePing, takeInstallSlot } from "./ping";
import { handleUsage } from "./usage";
import type { Env, QuotaResult } from "./types";

const FROM = "diagnostics@pheeme.email";
// Must match `destination_address` of the NOTIFY binding in wrangler.jsonc.
const TO = "ajg0360@gmail.com";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/usage") {
      return handleUsage(request, {
        bucket: env.BUNDLES,
        perIp: env.PING_PER_IP,
        now: () => new Date(),
      });
    }
    if (pathname === "/v1/ping") {
      return handlePing(request, {
        bucket: env.BUNDLES,
        perIp: env.PING_PER_IP,
        installs: env.DAILY_CAP.getByName("global"),
        now: () => new Date(),
      });
    }
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

/** One instance (named "global") counts accepted uploads and new install IDs per UTC day. */
export class DailyCap extends DurableObject<Env> {
  async take(ip: string): Promise<QuotaResult> {
    return takeDailySlot(this.ctx.storage, new Date(), ip);
  }

  async takeInstall(ip: string): Promise<QuotaResult> {
    return takeInstallSlot(this.ctx.storage, new Date(), ip);
  }
}
