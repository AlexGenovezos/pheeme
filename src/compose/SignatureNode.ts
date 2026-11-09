import { Node } from "@tiptap/react";
import { cleanSignature } from "./signatures";

function signatureDom(html: unknown): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "gmail_signature";
  dom.setAttribute("data-smartmail", "gmail_signature");
  dom.innerHTML = cleanSignature(String(html ?? ""));
  return dom;
}

/**
 * The signature in the compose editor: one block (`div.gmail_signature`, as Gmail writes it) that keeps its
 * HTML as it is, logo and table included, rather than being flattened into paragraphs. It can be selected and
 * deleted, not edited in place: Settings › Signatures is where it changes.
 */
export const SignatureNode = Node.create({
  name: "signature",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      html: {
        default: "",
        parseHTML: (el: HTMLElement) => el.innerHTML,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "div.gmail_signature", priority: 1000 }];
  },

  renderHTML({ node }) {
    return signatureDom(node.attrs.html);
  },

  // In the editor it can't be typed into; the message itself carries no such attribute.
  addNodeView() {
    return ({ node }) => {
      const dom = signatureDom(node.attrs.html);
      dom.setAttribute("contenteditable", "false");
      return { dom };
    };
  },
});
