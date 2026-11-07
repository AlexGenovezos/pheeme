// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildMime, encodeHeader } from "./mime";

const BASE = {
  from: "diagnostics@pheeme.email",
  fromName: "Pheeme diagnostics",
  to: "ajg0360@gmail.com",
  replyTo: "jane@gmail.com",
  subject: "Pheeme diagnostics: jane@gmail.com (0.13.0, macOS 15.1)",
  text: "Line one\nLine two",
  messageId: "<abc123@pheeme.email>",
  date: new Date("2026-11-06T15:30:00Z"),
};

function split(raw: string) {
  const [head, body] = raw.split("\r\n\r\n");
  return { headers: head.split("\r\n"), body };
}

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function decodeWords(header: string): string {
  return header
    .replace(/\r\n /g, "")
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_m, b64: string) => decodeBase64Utf8(b64));
}

describe("buildMime", () => {
  it("writes the required headers with CRLF line endings", () => {
    const { headers } = split(buildMime(BASE));

    expect(headers).toEqual(
      expect.arrayContaining([
        "From: Pheeme diagnostics <diagnostics@pheeme.email>",
        "To: ajg0360@gmail.com",
        "Reply-To: jane@gmail.com",
        "Subject: Pheeme diagnostics: jane@gmail.com (0.13.0, macOS 15.1)",
        "Message-ID: <abc123@pheeme.email>",
        "Date: Fri, 06 Nov 2026 15:30:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
      ]),
    );
  });

  it("leaves out Reply-To when there is no reply address", () => {
    const { headers } = split(buildMime({ ...BASE, replyTo: null }));

    expect(headers.some((h) => h.startsWith("Reply-To"))).toBe(false);
  });

  it("base64-encodes the UTF-8 body in lines of at most 76 characters", () => {
    const text = "Café — 日本語 ".repeat(40);
    const { body } = split(buildMime({ ...BASE, text }));
    const lines = body.split("\r\n").filter(Boolean);

    expect(lines.every((l) => l.length <= 76)).toBe(true);
    expect(decodeBase64Utf8(lines.join(""))).toBe(text);
  });

  it("encodes a non-ASCII subject as RFC 2047 words that decode back", () => {
    const subject = "Pheeme diagnostics: josé@exämple.com (0.13.0, Windows 11 — 日本語版)";
    const raw = buildMime({ ...BASE, subject });
    const line = raw.split("\r\n\r\n")[0].match(/Subject: (.*(?:\r\n .*)*)/)?.[1] ?? "";

    expect(line).toMatch(/^=\?UTF-8\?B\?/);
    expect(line.split("\r\n").every((l) => l.length <= 77)).toBe(true);
    expect(decodeWords(line)).toBe(subject);
  });
});

describe("encodeHeader", () => {
  it("passes printable ASCII through unchanged", () => {
    expect(encodeHeader("Hello (v1)")).toBe("Hello (v1)");
  });

  it("never splits a multi-byte character across encoded words", () => {
    const value = "€".repeat(40);
    const encoded = encodeHeader(value);

    expect(encoded.split("\r\n ").length).toBeGreaterThan(1);
    expect(decodeWords(encoded)).toBe(value);
  });
});
