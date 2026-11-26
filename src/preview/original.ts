import type { EmailAddress, OriginalMessage } from "../lib/tauri";
import type { FixtureMessage } from "./fixtures";

const person = (a: EmailAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);

/**
 * What Show original answers in the browser preview: a realistic source for a fixture message (Gmail's own
 * `Authentication-Results` above the sender's headers, a multipart body) with the summary read from it, the way
 * Rust does. `?original=fail` answers a failed DMARC and a softfail; `?original=offline` can't reach Gmail.
 */
export function previewOriginal(
  m: FixtureMessage,
  threadSubject: string,
  mode: string | null,
): OriginalMessage {
  if (mode === "offline")
    throw { code: "network", message: "Can't reach Gmail. Check your connection and try again." };
  const from = person({ name: m.fromName, address: m.fromAddress });
  const to = m.to.map(person).join(", ");
  const subject = threadSubject;
  const domain = m.fromAddress.split("@")[1] ?? "example.com";
  const messageId = `<CAK${m.id.padEnd(12, "x")}@mail.${domain}>`;
  const date = new Date(m.date).toUTCString().replace("GMT", "+0000");
  const failed = mode === "fail";
  const dkim = failed ? "fail" : "pass";
  const spf = failed ? "softfail" : "pass";
  const dmarc = failed ? "fail (p=REJECT sp=REJECT dis=NONE)" : "pass (p=NONE sp=NONE dis=NONE)";
  const text = (m.bodyText ?? "").trim();
  const source = [
    "Delivered-To: you@example.com",
    "Received: by 2002:a05:6a20:1234:b0:1a2:3b4c with SMTP id abcd;",
    "        Tue, 24 Nov 2026 07:17:03 -0800 (PST)",
    "Authentication-Results: mx.google.com;",
    `       dkim=${dkim} header.i=@${domain} header.s=selector1 header.b=Qk3xT9aA;`,
    `       spf=${spf} (google.com: domain of ${m.fromAddress} designates 203.0.113.9 as permitted sender) smtp.mailfrom=${m.fromAddress};`,
    `       dmarc=${dmarc} header.from=${domain}`,
    `Message-ID: ${messageId}`,
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="000000000000a1b2c3"',
    "",
    "--000000000000a1b2c3",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
    "",
    "--000000000000a1b2c3",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    `<div dir=3D"ltr">${text.replace(/\n/g, "<br>")}</div>`,
    "",
    "--000000000000a1b2c3--",
    "",
  ].join("\r\n");
  return {
    messageId,
    createdAt: m.date,
    from,
    to,
    subject,
    auth: [
      { method: "dkim", result: dkim, detail: `header.i=@${domain} header.s=selector1` },
      {
        method: "spf",
        result: spf,
        detail: `(google.com: domain of ${m.fromAddress} designates 203.0.113.9 as permitted sender) smtp.mailfrom=${m.fromAddress}`,
      },
      {
        method: "dmarc",
        result: failed ? "fail" : "pass",
        detail: `${dmarc.slice(dmarc.indexOf("("))} header.from=${domain}`,
      },
    ],
    source,
    truncated: false,
  };
}
