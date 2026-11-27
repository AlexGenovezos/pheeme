import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, test } from "vitest";
import { replaceSignature } from "./Editor";
import { SignatureNode } from "./SignatureNode";
import { cleanSignature, signatureBlock } from "./signatures";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** What the compose editor makes of `content`: its document's node types and the HTML it would send. */
function parsed(content: string) {
  editor = new Editor({ extensions: [StarterKit, SignatureNode], content });
  const signatures: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "signature") signatures.push(String(node.attrs.html));
  });
  return { signatures, html: editor.getHTML() };
}

const OVERLAY =
  '<div class="gmail_signature"><div style="position:fixed;inset:0;z-index:9999">Sign in again</div></div>';

test("the message's own signature stays one block, logo and table included", () => {
  const mine =
    '<table><tbody><tr><td><img src="https://example.com/logo.png"></td></tr></tbody></table>';
  const { signatures, html } = parsed(`<p>Hi</p>${signatureBlock(mine)}`);
  expect(signatures).toEqual([mine]);
  expect(html).toContain(mine);

  // Gmail on the web wraps the body, signature included, in a plain div.
  expect(
    parsed(`<div dir="ltr"><div>Hi</div>${signatureBlock("<b>Me</b>")}</div>`).signatures,
  ).toEqual(["<b>Me</b>"]);
});

test("a signature inside quoted mail is never rendered as raw HTML", () => {
  for (const quoted of [
    `<blockquote>${OVERLAY}</blockquote>`,
    `<div class="gmail_quote"><div class="gmail_attr">Bo wrote:</div>${OVERLAY}</div>`,
    `<div class="gmail_quote"><blockquote class="gmail_quote"><div>${OVERLAY}</div></blockquote></div>`,
    `<ul><li>${OVERLAY}</li></ul>`,
  ]) {
    const { signatures, html } = parsed(`<p>Mine</p>${signatureBlock("<b>Me</b>")}${quoted}`);
    expect(
      signatures.filter((s) => s.includes("Sign in again")),
      quoted,
    ).toEqual([]);
    expect(html, quoted).not.toContain("position");
    // The words survive as ordinary text.
    expect(html, quoted).toContain("Sign in again");
  }
});

test("signature HTML can't cover or restyle the app", () => {
  const cleaned = cleanSignature(
    '<style>body{display:none}</style><div style="position: fixed; inset: 0; z-index: 9999; color: red">x</div>' +
      '<form action="https://example.com"><input name="password"><button>Go</button></form>' +
      '<p style="position:absolute !important">y</p><span style="color: blue">z</span>',
  );
  expect(cleaned).not.toMatch(/position|z-index|<style|<form|<input|<button/i);
  expect(cleaned).toContain("color: red");
  expect(cleaned).toContain('<span style="color: blue">z</span>');
  expect(cleaned).not.toContain('style=""');

  // Even a top-level one (pasted, or a draft flattened by an older version) renders without the overlay.
  expect(parsed(OVERLAY).html).not.toMatch(/position|z-index/);
});

test("signature HTML can't play audio or video", () => {
  const cleaned = cleanSignature(
    '<audio autoplay src="https://example.com/a.mp3"></audio>' +
      '<video autoplay><source src="https://example.com/v.mp4"></video><b>Me</b>',
  );
  expect(cleaned).not.toMatch(/<audio|<video|<source/i);
  expect(cleaned).toContain("<b>Me</b>");
});

test("a link in the signature is inert in the editor: a click never navigates the app", () => {
  const element = document.body.appendChild(document.createElement("div"));
  editor = new Editor({
    element,
    extensions: [StarterKit, SignatureNode],
    content: `<p>Hi</p>${signatureBlock('<a href="https://example.com/">site</a>')}`,
  });
  const link = element.querySelector(".gmail_signature a")!;
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  element.remove();
});

test("a signature filled in after the panel opened isn't something Undo takes back", () => {
  editor = new Editor({ extensions: [StarterKit, SignatureNode], content: "<p></p>" });
  replaceSignature(editor, "<b>Me</b>", { fillIn: true });
  expect(editor.getHTML()).toContain("<b>Me</b>");
  expect(editor.can().undo()).toBe(false);
  replaceSignature(editor, "<b>Other</b>");
  expect(editor.can().undo()).toBe(true);
});
