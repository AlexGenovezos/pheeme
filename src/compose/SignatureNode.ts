import { Node } from "@tiptap/react";
import { cleanSignature, isOwnSignatureBlock } from "./signatures";

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
 * deleted, not edited in place: Settings › Compose is where it changes.
 *
 * Only the message's own signature becomes this node. A signature block inside quoted mail (a draft another
 * client saved, something pasted) is someone else's HTML: it falls through to the ordinary rules and is read as
 * plain paragraphs. What does render is sanitized (`cleanSignature`) and boxed in by `compose.css`.
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
    return [
      {
        tag: "div.gmail_signature",
        priority: 1000,
        getAttrs: (el: HTMLElement) => (isOwnSignatureBlock(el) ? null : false),
      },
    ];
  },

  renderHTML({ node }) {
    return signatureDom(node.attrs.html);
  },

  // In the editor it can't be typed into; the message itself carries no such attribute.
  addNodeView() {
    return ({ node }) => {
      const dom = signatureDom(node.attrs.html);
      dom.setAttribute("contenteditable", "false");
      // Its links are inert, as the editor's own are (`openOnClick: false`): a click never navigates the app.
      dom.addEventListener("click", (event) => {
        if ((event.target as Element | null)?.closest?.("a[href]")) event.preventDefault();
      });
      return { dom };
    };
  },
});
