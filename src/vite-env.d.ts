/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the release workflow: when the release's tag was pushed (ISO 8601). */
  readonly VITE_RELEASE_PUSHED_AT?: string;
}
