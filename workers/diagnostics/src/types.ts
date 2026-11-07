// The small slices of the Workers runtime this Worker uses, declared here so it
// needs no npm dependencies. Shapes follow the Cloudflare docs; widen them only
// when the code starts using more.

/** R2 bucket binding (`put` only). */
export interface Bucket {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

/** Workers rate limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The daily upload cap, a Durable Object stub in production. */
export interface DailyCapCounter {
  take(): Promise<boolean>;
}

/** The notification email, before it becomes MIME. */
export interface Notification {
  subject: string;
  replyTo: string | null;
  text: string;
}

/** Everything `handleUpload` touches outside the request. */
export interface Deps {
  bucket: Bucket;
  perIp: RateLimiter;
  dailyCap: DailyCapCounter;
  notify(mail: Notification): Promise<void>;
  now(): Date;
  id(): string;
}

/** Durable Object key-value storage (`ctx.storage`), async API subset. */
export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** What the daily cap Durable Object keeps under the key `state`. */
export interface DailyCapState {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  count: number;
}

/** `send_email` binding. */
export interface SendEmail {
  send(message: unknown): Promise<unknown>;
}

/** Durable Object namespace binding, reduced to `getByName`. */
export interface DailyCapNamespace {
  getByName(name: string): DailyCapCounter;
}

export interface Env {
  BUNDLES: Bucket;
  PER_IP: RateLimiter;
  DAILY_CAP: DailyCapNamespace;
  NOTIFY: SendEmail;
}
