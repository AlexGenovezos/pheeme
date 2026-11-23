import { mergeAttributes, Node } from "@tiptap/react";

export interface InlineImageOptions {
  /** Where to read the image a `cid:` URL names, or `null` when it can't be shown. */
  resolve(contentId: string): Promise<string | null>;
}

const CID = "cid:";

/**
 * An image pasted into the message's text. It is stored and sent as `<img src="cid:…">` (the image itself goes
 * beside the HTML), and drawn in the editor from the staged file the Content-ID names.
 */
export const InlineImageNode = Node.create<InlineImageOptions>({
  name: "inlineImage",
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { resolve: () => Promise.resolve(null) };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
    };
  },

  // Only images sent with the message; a remote image's address isn't something the editor writes.
  parseHTML() {
    return [{ tag: 'img[src^="cid:" i]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { style: "max-width:100%" })];
  },

  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      img.className = "compose-image";
      img.alt = node.attrs.alt ?? "";
      img.draggable = false;
      const src = String(node.attrs.src ?? "");
      if (src.toLowerCase().startsWith(CID)) {
        void this.options.resolve(src.slice(CID.length)).then((url) => {
          if (url) img.src = url;
          else img.classList.add("compose-image--missing");
        });
      }
      return { dom: img };
    };
  },
});
