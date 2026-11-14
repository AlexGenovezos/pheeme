// The small slices of the Workers runtime this Worker uses, declared here so it
// needs no npm dependencies. Shapes follow the Cloudflare docs; widen them only
// when the code starts using more.

/** An R2 object body, as `get` returns it. */
export interface BucketObject {
  json<T>(): Promise<T>;
}

/** R2 bucket binding (`put` and `get` only). */
export interface Bucket {
  get(key: string): Promise<BucketObject | null>;
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

/** Outcome of taking a daily slot: which limit, if any, said no. */
export type QuotaResult = "ok" | "ip_limit" | "global_limit";

/** The daily quotas, a Durable Object stub in production. The IP is hashed
 * with a daily salt inside; it is never stored as is. */
export interface DailyCapCounter {
  /** One accepted upload. */
  take(ip: string): Promise<QuotaResult>;
  /** One install ID never seen before. */
  takeInstall(ip: string): Promise<QuotaResult>;
}

/** The part of the daily quotas `handlePing` uses. */
export type InstallQuota = Pick<DailyCapCounter, "takeInstall">;

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

/** Everything `handlePing` touches outside the request. */
export interface PingDeps {
  bucket: Bucket;
  perIp: RateLimiter;
  installs: InstallQuota;
  now(): Date;
}

/** What `installs/<installId>.json` holds: the latest ping from one install. */
export interface InstallRecord {
  /** ISO time of the first ping still on record (resets if the install went 30 days silent). */
  firstSeen: string;
  lastSeen: string;
  version: string;
  os: string;
  osVersion: string;
  arch: string;
}

/** Durable Object key-value storage (`ctx.storage`), async API subset. */
export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** What the daily cap Durable Object keeps per quota (`state`, `installs`). */
export interface QuotaState {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  count: number;
  /** Slots taken per IP today, keyed by a salted hash of the IP. */
  ips?: Record<string, number>;
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
  PING_PER_IP: RateLimiter;
  DAILY_CAP: DailyCapNamespace;
  NOTIFY: SendEmail;
}
