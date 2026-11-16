// The sidebar's Labels section: the account's user labels as a tree, with each label's menu, and the hidden ones
// under More.
import { ChevronRight, EllipsisVertical, Plus } from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { IconButton } from "../../components/ui/IconButton";
import { ListRow } from "../../components/ui/ListRow";
import { openColorPopover } from "../../labels/ColorPopover";
import { openDeleteLabel, openLabelDialog } from "../../labels/dialogStore";
import { editLabel } from "../../labels/edit";
import { chipColors } from "../../labels/palette";
import { useRevealStore } from "../../labels/reveal";
import {
  buildLabelTree,
  filterSidebarTree,
  hiddenSidebarTree,
  type LabelNode,
  visibleInSidebar,
} from "../../labels/tree";
import { type ContextMenuItem, isContextMenuKey, showContextMenu } from "../../lib/contextMenu";
import type { LabelInfo } from "../../lib/tauri";
import { cx } from "../../lib/utils";
import { dropTarget } from "../../mail/dragMail";
import { formatCount } from "../../mail/mailboxes";
import { useLabelStore } from "../../store/labelStore";
import { useUiStore } from "../../store/uiStore";
import { activateOnKey, below } from "./keys";
import { Section } from "./Section";
import { NO_COUNTS, sameMailbox } from "./shared";

const NO_FOLDS: string[] = [];

const LIST_VISIBILITY = [
  { value: "labelShow", text: "Show in label list" },
  { value: "labelShowIfUnread", text: "Show if unread" },
  { value: "labelHide", text: "Hide in label list" },
] as const;

/** A label's ⋮ menu: colour, visibility, edit, add sublabel, delete. `anchor` is the row it belongs to. */
function labelMenu(accountId: string, label: LabelInfo, anchor: HTMLElement): ContextMenuItem[] {
  const list = label.labelListVisibility ?? "labelShow";
  const inMessages = label.messageListVisibility !== "hide";
  const edit = (change: Parameters<typeof editLabel>[2]) =>
    void editLabel(accountId, label.id, change);
  return [
    {
      id: "label-colour",
      label: "Label colour…",
      onSelect: () =>
        openColorPopover({ accountId, labelId: label.id, at: below(anchor), returnFocus: anchor }),
    },
    { type: "separator" },
    ...LIST_VISIBILITY.map(({ value, text }) => ({
      id: `label-list-${value}`,
      label: text,
      checked: list === value,
      onSelect: () => list !== value && edit({ labelListVisibility: value }),
    })),
    {
      id: "label-message-list",
      label: "Show in message list",
      checked: inMessages,
      onSelect: () => edit({ messageListVisibility: inMessages ? "hide" : "show" }),
    },
    { type: "separator" },
    {
      id: "label-edit",
      label: "Edit…",
      onSelect: () =>
        openLabelDialog({ mode: "edit", accountId, labelId: label.id, returnFocus: anchor }),
    },
    {
      id: "label-sublabel",
      label: "Add sublabel…",
      onSelect: () =>
        openLabelDialog({ mode: "create", accountId, parent: label.name, returnFocus: anchor }),
    },
    {
      id: "label-delete",
      label: "Delete label",
      danger: true,
      onSelect: () => openDeleteLabel(accountId, label.id, anchor),
    },
  ];
}

function LabelDot({ label }: { label: LabelInfo | null }) {
  const colors = label && chipColors(label);
  return (
    <span
      className={cx(
        "sidebar__label-dot",
        !label && "sidebar__label-dot--empty",
        label && !colors && "sidebar__label-dot--none",
      )}
      style={colors ? { backgroundColor: colors.background } : undefined}
      aria-hidden="true"
    />
  );
}

interface LabelRowProps {
  accountId: string;
  node: LabelNode;
  folded: boolean;
  unread: number;
}

/** One label (or a synthetic parent: not a link, no menu), with a fold chevron when it has sublabels. */
function LabelRow({ accountId, node, folded, unread }: LabelRowProps) {
  const { label } = node;
  const selected = useUiStore(
    (s) => label !== null && sameMailbox(s.mailbox, { accountId, labelId: label.id }),
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const parent = node.children.length > 0;
  const text = formatCount(unread);
  const fold = () => useUiStore.getState().toggleLabelFold(accountId, node.path);
  const go = () => label && useUiStore.getState().setMailbox({ accountId, labelId: label.id });
  const menu = (anchor: HTMLElement, at = below(anchor)) => {
    if (label) void showContextMenu(labelMenu(accountId, label, anchor), at);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isContextMenuKey(e)) {
      e.preventDefault();
      menu(e.currentTarget);
    } else activateOnKey(e, go);
  };

  return (
    <div
      className={cx("sidebar__label", parent && "sidebar__label--parent")}
      style={{ "--label-depth": node.depth } as CSSProperties}
      onContextMenu={(e) => {
        if (!label || !rowRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        menu(rowRef.current, { x: e.clientX, y: e.clientY });
      }}
    >
      <ListRow
        ref={rowRef}
        role={label ? "link" : "none"}
        tabIndex={label ? 0 : undefined}
        density="compact"
        aria-label={label ? node.path : undefined}
        aria-description={label && text ? `${text} unread` : undefined}
        selected={selected}
        className={cx(
          "sidebar__row",
          "sidebar__label-row",
          !label && "sidebar__label-row--synthetic",
        )}
        style={{ "--row-color": "var(--color-foreground)" } as CSSProperties}
        leading={<LabelDot label={label} />}
        title={<span title={node.path}>{node.leaf}</span>}
        meta={text ? <span aria-hidden="true">{text}</span> : undefined}
        onClick={label ? go : fold}
        onKeyDown={label ? onKeyDown : undefined}
        {...(label ? dropTarget(accountId, label.id) : {})}
      />
      {label && (
        <IconButton
          ref={menuRef}
          size="sm"
          className="sidebar__label-menu"
          label={`Options for ${node.path}`}
          icon={<EllipsisVertical />}
          onClick={() => {
            if (menuRef.current && rowRef.current) menu(rowRef.current, below(menuRef.current));
          }}
        />
      )}
      {parent && (
        <button
          type="button"
          className="sidebar__fold"
          aria-expanded={!folded}
          aria-label={`${node.leaf} sublabels`}
          onClick={fold}
        >
          <ChevronRight className="sidebar__chevron" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function LabelTreeRows({
  accountId,
  nodes,
  folded,
  unreadOf,
}: {
  accountId: string;
  nodes: LabelNode[];
  folded: string[];
  unreadOf: (label: LabelInfo) => number;
}) {
  return nodes.map((node) => {
    const isFolded = folded.includes(node.path);
    return (
      <Fragment key={node.path}>
        <LabelRow
          accountId={accountId}
          node={node}
          folded={isFolded}
          unread={node.label ? unreadOf(node.label) : 0}
        />
        {!isFolded && node.children.length > 0 && (
          <LabelTreeRows
            accountId={accountId}
            nodes={node.children}
            folded={folded}
            unreadOf={unreadOf}
          />
        )}
      </Fragment>
    );
  });
}

/**
 * The shown tree with labels kept only as ancestors of shown sublabels (show-if-unread with nothing unread)
 * turned into context rows, like synthetic parents: their actionable row is under More.
 */
function contextForHidden(nodes: LabelNode[], unreadOf: (label: LabelInfo) => number): LabelNode[] {
  return nodes.map((node) => ({
    ...node,
    label: node.label && visibleInSidebar(node.label, unreadOf(node.label)) ? node.label : null,
    children: contextForHidden(node.children, unreadOf),
  }));
}

/** The account's user labels as a tree: shown ones first, then a More row holding the hidden ones. */
export function LabelsSection({ accountId }: { accountId: string }) {
  const labels = useLabelStore((s) => s.userLabels(accountId));
  const counts = useLabelStore((s) => s.counts[accountId] ?? NO_COUNTS);
  const folded = useUiStore((s) => s.foldedLabels[accountId] ?? NO_FOLDS);
  const moreOpen = useUiStore((s) => s.labelsMoreOpen.includes(accountId));
  const pending = useRevealStore((s) => s.pending);
  const sectionRef = useRef<HTMLElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const moreId = useId();

  const { shown, hidden, unreadOf } = useMemo(() => {
    const unreadOf = (l: LabelInfo) => counts[l.id]?.unread ?? 0;
    const tree = buildLabelTree(labels);
    return {
      shown: contextForHidden(filterSidebarTree(tree, unreadOf), unreadOf),
      hidden: hiddenSidebarTree(tree, unreadOf),
      unreadOf,
    };
  }, [labels, counts]);

  // "Manage labels": bring the section into view and focus its first label.
  useEffect(() => {
    if (!pending) return;
    useRevealStore.setState({ pending: 0 });
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    const first = rowsRef.current?.querySelector<HTMLElement>('[role="link"]');
    (first ?? createRef.current)?.focus({ preventScroll: true });
  }, [pending]);

  return (
    <Section
      sectionRef={sectionRef}
      title="Labels"
      action={
        <IconButton
          ref={createRef}
          size="sm"
          label="Create label"
          icon={<Plus />}
          onClick={() =>
            openLabelDialog({ mode: "create", accountId, returnFocus: createRef.current })
          }
        />
      }
    >
      <div ref={rowsRef} className="sidebar__labels">
        <LabelTreeRows accountId={accountId} nodes={shown} folded={folded} unreadOf={unreadOf} />
        {hidden.length > 0 && (
          <>
            <button
              type="button"
              className="sidebar__more"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              onClick={() => useUiStore.getState().toggleLabelsMore(accountId)}
            >
              <span className="sidebar__more-text">More</span>
              <ChevronRight className="sidebar__chevron" aria-hidden="true" />
            </button>
            <div id={moreId} className="sidebar__labels" hidden={!moreOpen}>
              {moreOpen && (
                <LabelTreeRows
                  accountId={accountId}
                  nodes={hidden}
                  folded={folded}
                  unreadOf={unreadOf}
                />
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
