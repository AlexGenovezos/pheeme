// Every mail action, shared by buttons, context menus and keyboard shortcuts. The actions live in sibling modules
// (`change.ts` is what they share); this is the one place the rest of the app imports them from.
export { composeNew, respond } from "../compose/respond";
export {
  applyLabel,
  labelMembership,
  labelMenuAnchor,
  moveOrigin,
  moveTo,
  openLabelMenu,
  openMoveMenu,
  toggleLabel,
} from "./labelActions";
export { moveToCategory, shownCategory } from "./categories";
export { moveSelection, openFocused, toggleCheckFocused, closeConversation } from "./navigation";
export {
  archive,
  archiveSlotAction,
  markTabRead,
  setRead,
  setStarred,
  toggleStar,
  trash,
} from "./mutations";
export { findSimilar, markSearchResultsRead } from "./searchActions";
export { openAndMarkRead, targets, targetsOf } from "./change";
