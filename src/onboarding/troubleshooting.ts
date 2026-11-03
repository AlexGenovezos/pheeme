// Plain-language fixes for known OAuth failures (design doc §4 item 1).

export interface Problem {
  code: string;
  /** What the user sees, in Google's words where it comes from Google. */
  title: string;
  fix: string;
  link?: { label: string; url: string };
  /** Where the fix happens: back to the credentials form, or retry the sign-in. */
  action: "credentials" | "retry";
}

/**
 * Errors Google shows on its own page in the browser. They never reach Pheeme,
 * so the waiting screen lists them for the user to match.
 */
export const BROWSER_PROBLEMS: Problem[] = [
  {
    code: "redirect_uri_mismatch",
    title: "Error 400: redirect_uri_mismatch",
    fix: "The client isn't a Desktop app client. Create a new client with application type Desktop app, then enter its ID and secret.",
    link: { label: "Open Create client", url: "https://console.cloud.google.com/auth/clients/create" },
    action: "credentials",
  },
  {
    code: "invalid_client",
    title: "Error 401: invalid_client, or “The OAuth client was not found”",
    fix: "The client ID has a typo or the client was deleted. Copy the client ID again from the Clients page.",
    link: { label: "Open Clients", url: "https://console.cloud.google.com/auth/clients" },
    action: "credentials",
  },
  {
    code: "org_internal",
    title: "Error 403: org_internal",
    fix: "The app's audience is Internal, so only accounts in that Google Workspace organization can sign in. Use an account from the organization, or change the audience to External.",
    link: { label: "Open Audience", url: "https://console.cloud.google.com/auth/audience" },
    action: "retry",
  },
  {
    code: "access_denied",
    title: "Error 403: access_denied (“has not completed the Google verification process”)",
    fix: "The app is still in Testing and this account isn't a test user. Publish the app, or add the address under Test users.",
    link: { label: "Open Audience", url: "https://console.cloud.google.com/auth/audience" },
    action: "retry",
  },
  {
    code: "admin_policy_enforced",
    title: "Error 400: admin_policy_enforced",
    fix: "Your Google Workspace administrator blocks apps they haven't approved. Ask them to trust your client ID in the Admin console (Security → API controls), or create the Google Cloud project inside your organization.",
    action: "retry",
  },
];

const TITLES: Record<string, string> = {
  access_denied: "Google didn't grant access",
  org_internal: "This account isn't in the app's organization",
  admin_policy_enforced: "Your administrator blocks this app",
  invalid_client: "Google didn't accept the client ID or secret",
  redirect_uri_mismatch: "That isn't a Desktop app client",
  invalid_grant: "Signed out by Google",
  code_rejected: "The sign-in expired",
  missing_scope: "Pheeme needs Gmail access",
  no_refresh_token: "Google didn't return a lasting sign-in",
  timeout: "Sign-in timed out",
  network: "Couldn't reach Google",
  keychain_unavailable: "No system keychain",
  keychain_locked: "Keychain locked",
  invalid_input: "Check the client ID and secret",
};

export const problemTitle = (code: string) => TITLES[code] ?? "Sign-in didn't finish";

/** Errors whose fix is to correct the client ID or secret. */
export const isCredentialProblem = (code: string) =>
  ["invalid_client", "redirect_uri_mismatch", "invalid_input"].includes(code);
