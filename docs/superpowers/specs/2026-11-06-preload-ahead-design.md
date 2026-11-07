# Preload ahead: every email is already there when you arrive

## Intent

Pheeme's whole point is to feel stupid fast. The moment that matters most: Alex is in **Updates** with **Unread only** on, holding the down arrow. He spends under a second on each email. When he lands on one, its **full body is already completely loaded**: text, layout and images, with no blank pane, no spinner and no images popping in late. The same goes for switching to a category or turning Unread only on. The first emails there should already be ready.

## What happens today (main @ 5dd56c0)

- **Text is usually local.** The backfill stores full bodies for the last 180 days (`FULL_BODY_DAYS`), and the initial sync stores the newest 50 Inbox threads in full. `get_thread` only goes to Gmail for a message with no cached body. That happens for older mail, or while a new account's backfill is still running.
- **Look-ahead is one row each way.** `prefetchAround` in `src/mail/actions.ts` warms only the rows directly above and below the open thread. The detail cache (`threadStore`, `DETAIL_CACHE_SIZE = 30`) is an LRU of `ThreadDetail`s. Nothing is warmed when a list first loads, when the mailbox changes, or when Unread only toggles.
- **Images are never fetched early.** HTML bodies render in a sandboxed iframe written synchronously (#140), with remote images allowed for an opened message (`allowRemote: true`). They load straight from the senders' servers (there's no proxy), so they only start downloading when the email is on screen. Updates mail (receipts, shipping, newsletters) is mostly images.
- **Each body is parsed, sanitised and laid out from scratch** when shown.

## Goals

1. **Arrowing through a list never lands on an unready email,** at a held-arrow pace of several emails a second, and for at least the first ~20 rows of any list.
2. **On list arrival** (opening a mailbox or category, toggling Unread only, a search's results): the first ~20 threads of *that list as shown* are preloaded in full. With Unread only on, that means the unread list, not the unfiltered one.
3. **While navigating,** a window keeps moving ahead of the open thread. It is weighted in the direction of travel (mostly ahead, a little behind), so a held arrow keeps finding ready emails as far as the user goes.
4. **"Fully loaded" means the images too:** the thread detail is cached, missing bodies are fetched from Gmail, and the remote images those bodies use are already downloaded, so they paint with the body.
5. **Category switches are instant too:** in the background, the first ~20 threads of each main category of the active account are preloaded. The categories are Primary, Updates, Promotions, Social and Forums (the `CATEGORIES` in `src/mail/mailboxes.ts`), plus the Inbox.
6. **The user is told about the image tradeoff** (below), and can turn image preloading off.

## Non-goals

- Changing what's synced or how long bodies are kept (`FULL_BODY_DAYS` stays).
- Preloading every label, Sent, Drafts or old mail. It's only the lists the user is looking at, plus the main categories.
- Calendar, compose or search-ranking work.

## Anti-goals (a failure even if it works)

- **Preloading marks anything read** or changes any mail state. A preload is a read-only warm-up. Only actually opening a thread marks it read, as it does today.
- **Preloading slows the thing in front of the user.** The open thread, the list query and the arrow key always come first. Preload work yields to them, and never queues ahead of the user's own `get_thread`.
- **It eats Gmail quota that sync, sends or opening mail need.** Body fetches for preloading count as bulk work under the existing limiter (`BULK_SHARE`). A rate limit stops preloading; it doesn't surface an error.
- **Memory grows without bound.** Caches stay bounded. `e2e/memory.spec.ts` keeps passing, with any budget change justified there.
- **Errors or toasts from preloading.** Failures are silent, like the current `quiet` prefetch.

## The image tradeoff (decided by Alex)

Downloading an email's images tells its sender it was "opened" (tracking pixels), and shows them your IP address and rough location, because Pheeme loads images directly from the senders' servers. That already happens when you open an email; preloading extends it to emails you skip past or never reach. **Alex accepted this for the speed, on the condition that users are told.**

- A new setting, **Preload images**, sits in the Reading section of Settings › Appearance next to `reading.size` (`src/settings/pages.tsx`). It's **on by default**.
- Its description says plainly: preloading images lets senders see that an email was opened, along with your IP address and approximate location, even for emails you skip. Turning it off keeps text preloading, and loads images only when you open an email.
- With it off, nothing about images changes from today's behaviour.

## Constraints

- Follow the repo conventions in `CLAUDE.md`: IPC wrappers in `src/lib/tauri.ts`, settings as `SettingDef`s, mail changes only through the outbox (not relevant here; preloading is read-only), and `cargo sqlx prepare` after any query change.
- Must work in the browser preview (`npm run dev`, `src/preview/` fixtures), so it's testable in Vitest and Playwright. Real-app checks happen on the Mac (`mac-dev` skill). There's no Tauri GUI on the devbox.
- The webviews are WebKit (macOS/Linux) and WebView2 (Windows). The image warm-up must reach the cache the email iframe actually loads from (the srcdoc iframe is `allow-same-origin`, so it shares the app's origin). It also has to work under the iframe's CSP and the app CSP's `img-src`, which already allows `https: http:`.
- Existing behaviours must survive: the sync eviction rules in `threadStore` (an evicted or superseded preload must not repopulate stale data), pending optimistic patches (`withPending`), and auto mark-read's wait for the detail (`waitForDetail`).
- The in-flight branch `feat/send-diagnostics` changes how prefetched threads are treated when the user opens them ("open prefetched threads as the user's request"). Rebase onto it, or coordinate with it, if it lands first.

## Cold arrivals (Claude's call)

Nothing can be ready before it's been fetched. A list that has never been warmed can't be instant on its very first email. Examples are a brand-new search, or the first Unread only toggle on a mailbox whose unread mail has no cached bodies. So:

- Most arrivals are warm by design. The main categories are preloaded in the background, and their text is usually local already.
- On a cold arrival, preloading starts at once, top row first and then outward. Opening the first email is never slower than today. The app adds no artificial wait or "preparing" state.
- Goal 1's guarantee applies to warm lists. On a cold list it starts holding as soon as the window has caught up. In the Updates walk-through, the user is reading the first email while the rest fill in.

## Success measure

- **Primary (real Mac, Alex's account):** in Updates with Unread only on, hold the down arrow through 20+ emails. Each email's body, with its images, is fully painted the moment it's shown. Alex is the judge.
- **Automated:** Vitest covers the scheduling. That includes which keys get preloaded on list load, on Unread only, on navigation (with direction weighting) and on mailbox switch; that preloads never mark read; that they're cancelled or deprioritised when the list changes; and that image warm-up obeys the setting. Add a Playwright check in the preview that arrowing through the first 20 rows never shows a loading state.

## Left to the builder

- **The exact numbers:** the window size (~20 is Alex's figure on list arrival), how far ahead vs. behind, the detail cache size, and how many preloads run at once. Pick them, measure, and write down why.
- **How images are warmed.** The options are: an off-screen `Image()`/`decode()` in the app document; keeping the next one or two threads pre-rendered in hidden iframes so layout is done too; or both (pre-render the very next thread, warm images further out). Pick from measurement on WebKit. Note that images served `no-store` can't be warmed from cache; pre-rendering is the only way to get those.
- **Where the scheduler lives.** Extend `threadStore.prefetch`, or add a small preload module that subscribes to `mailStore`/`uiStore` (list loads, Unread only, mailbox switches, `openThread` and its direction). Also decide how it prioritises and cancels.
- **Whether backend help is needed:** for example a batch "get these threads" command, or extracting a body's image URLs on the Rust side during sanitising so the frontend doesn't parse HTML. It's also open how background category preloading gets its lists (the existing `listThreads` with a 20-row limit is the obvious route).
- How preloading behaves with several accounts in All Inboxes. A reasonable default is to treat it as one list.
