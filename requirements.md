# Pi Extension: `/history` — Project Session Picker

## 1. Overview

A pi.dev extension that adds a `/history` slash command. Running it shows a
list of past pi sessions scoped to the **current project** (cwd), sorted
**most recent first**, and lets the user pick one to continue from — same
underlying mechanism as `/resume`, but with richer, auto-generated labels and
a preview snippet per item.

## 2. Problem / Motivation

`/resume` exists natively but lists sessions by raw file path or first
message verbatim. For projects with many sessions (e.g. EduBridge, pi.dev
tooling itself), it's hard to tell sessions apart at a glance. `/history`
should make each entry scannable: a short generated title, a relative
timestamp, and a one-line preview of what the conversation was about.

## 3. Requirements (confirmed)

| Decision | Choice |
|---|---|
| Title when no `setSessionName()` was used | Derive a short title from the **first user message**, plus show the timestamp |
| Sort order | Most recent first |
| Preview | Each item shows a snippet (in addition to title) |

## 4. Functional Spec

### Command
- Name: `/history`
- Scope: project-local (lists sessions for `ctx.cwd` only, not global)
- No arguments needed for v1 (optional: `/history <filter text>` later for fuzzy search)

### Data flow
1. `SessionManager.list(ctx.cwd)` → array of session file paths/metadata for this project.
2. For each session, open it (`SessionManager.open(path)`) to read:
   - `getSessionName()` → use as title if set
   - If not set: scan entries for first `message` entry where `message.role === "user"` → derive title from its text (see "Title generation" below)
   - Last meaningful message (prefer last `assistant` text, fallback to last `user` text) → use as **preview/description**
   - Header/last entry `timestamp` → for sorting + relative time display
3. Sort all sessions by last-activity timestamp, descending.
4. Render via `SelectList` (from `@mariozechner/pi-tui`) inside `ctx.ui.custom()`, using:
   - `label`: `"{title} · {relativeTime}"`
   - `description`: preview snippet (truncated, single line)
5. On select → `ctx.switchSession(selectedPath)`.
6. On cancel/escape → no-op, stay in current session.

### Title generation (when no session name set)
- Take first user message text (handle both `string` and `(TextContent|ImageContent)[]` content shapes — extract first `TextContent.text`).
- Strip newlines, collapse whitespace.
- Truncate to ~50-60 chars, ellipsis if cut.
- Fallback if first user message is empty/only an image: use `"Session — {date}"`.

### Preview snippet
- Walk `sm.getBranch()` (current branch, root→leaf) backwards.
- Pick **last `assistant` message with text content**; fallback to last `user` message with text.
- Skip `toolResult`, `thinking`, `system`, and other non-message entries.
- Truncate to ~80 chars, preferring a sentence boundary (`. `, `! `, `? `).
- Strip markdown/code fences/newlines for cleanliness.

### Relative time formatting
- `< 1 min` → `"just now"`, `< 1 hr` → `"Xm ago"`, `< 24 hr` → `"Xh ago"`
- `= 1 day` → `"yesterday"`, `< 7 days` → `"Xd ago"`
- `≥ 7 days, same year` → `"Jun 14"`, different year → `"Jun 14, 2025"`
- Based on `SessionInfo.modified` (Date).

### Empty state
- If no sessions found for this project, `ctx.ui.notify("No sessions found for this project", "info")` and return — don't open picker.

### Current session
- **Resolved**: Show it, label suffixed with `(current)`. Pre-selected in the picker. Re-selecting is a no-op (doesn't switch).

## 5. Non-functional / Constraints
- Must not block UI thread — `SessionManager.list` / `.open` are likely async or fast sync reads of JSONL; reading many session files on every `/history` call could be slow for large histories. Consider capping to most recent N (e.g. 30) sessions, or lazy-loading previews only for visible window.
- Must gracefully handle malformed/corrupted `.jsonl` lines (wrap parse in try/catch per file; skip file on failure rather than crashing the command).
- Respect tree structure — a session's "last message" should come from `getBranch()` (current leaf path), not just raw `getEntries()` order, to avoid showing an abandoned branch's content as the preview.

## 6. Confirmed Pi API Reference (from official docs, June 2026)

> **Note**: The actual installed package namespace is `@earendil-works/pi-coding-agent`
> and `@earendil-works/pi-tui` (v0.79.8). The `@mariozechner/` namespace in the
> original docs was a planned rename. Implementation uses `@earendil-works/...`.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("history", {
    description: "Browse and resume sessions for this project",
    handler: async (_args, ctx) => {
      // 1. List sessions scoped to current project
      const sessions = await SessionManager.list(ctx.cwd);

      // 2. For each: open, extract name/title/preview/timestamp
      //    sm.getSessionName() / sm.getBranch() / sm.getEntries()

      // 3. Sort by last activity desc

      // 4. Build SelectItem[]: { value: path, label, description }

      // 5. Show via ctx.ui.custom() + SelectList, or simpler ctx.ui.select()
      //    if description isn't required by simpler API (it is here -> use SelectList directly)

      // 6. await ctx.switchSession(chosenPath)
    },
  });
}
```

### Key APIs confirmed available
- `SessionManager.list(cwd, sessionDir?, onProgress?)` — list sessions for a directory (this project only). Returns `SessionInfo[]` with `path`, `id`, `cwd`, `name?`, `created`, `modified`, `messageCount`, `firstMessage`, `allMessagesText`.
- `SessionManager.listAll(onProgress?)` — all projects (NOT used here, but good to know exists)
- `SessionManager.open(path, sessionDir?)` — open a specific session file
- `sm.getSessionName()` — display name if set via `/name` or `pi.setSessionName()`
- `sm.getEntries()` / `sm.getBranch(fromId?)` / `sm.getLeafEntry()` — tree access
- `sm.getHeader()` — session metadata
- `sm.getSessionFile()` — path
- `ctx.switchSession(sessionPath)` — switches active session (fires `session_before_switch` → `session_shutdown` → `session_start` with `reason: "resume"`)
- `ctx.ui.custom<T>((tui, theme, keybindings, done) => Component)` — for custom picker UI
- `getSelectListTheme()` — exported from `@earendil-works/pi-coding-agent`; returns a themed `SelectListTheme`
- `SelectList` (from `@earendil-works/pi-tui`): constructor `(items: SelectItem[], maxVisible: number, theme, layout?)`; `SelectItem = { value, label, description? }`; events `onSelect`, `onCancel`, `onSelectionChange`; `.setFilter(text)`; `.setSelectedIndex(index)`

### Session entry shapes relevant to title/preview extraction
```ts
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string; // ISO
  message: AgentMessage; // UserMessage | AssistantMessage | ToolResultMessage | ...
}
interface SessionInfoEntry {
  type: "session_info";
  name: string; // set via /name or pi.setSessionName()
}
```

## 7. TODO Checklist

- [x] Scaffold extension folder: `.pi/extensions/history/index.ts` (project-local, single file)
- [x] Implement session listing via `SessionManager.list(ctx.cwd)`
- [x] Implement title extraction — session name → first user message → fallback (uses `SessionInfo.name` / `.firstMessage` directly, no session-open needed)
- [x] Implement preview extraction — last meaningful message on current branch via `sm.getBranch()`, truncated at sentence boundary
- [x] Implement `formatRelativeTime(date)` helper
- [x] Implement sort by `modified` timestamp, descending
- [x] Build `SelectItem[]` combining title/time as `label`, preview as `description`
- [x] Wire up `ctx.ui.custom()` + `SelectList` with `getSelectListTheme()`
- [x] Handle selection → `await ctx.switchSession(value)` (skip if same as current)
- [x] Handle cancel/escape → no-op
- [x] Handle empty state → `ctx.ui.notify("No sessions found for this project", "info")`
- [x] Handle current session → show with `(current)` suffix, pre-selected, re-select is no-op
- [x] Wrap per-file parsing in try/catch, fallback to firstMessage on error
- [x] Cap sessions loaded to 50 (MAX_SESSIONS)
- [ ] Test: project with 0 sessions, 1 session, many sessions
- [ ] Test: session with `setSessionName()` set vs not set
- [ ] Test: session whose first user message is image-only (no text) → fallback title
- [ ] Test: selecting current session — confirm no weird state issues
- [ ] (Optional v2) `/history <query>` fuzzy filter using `SelectList.setFilter`
- [ ] (Optional v2) Delete session from picker (`Ctrl+D`, mirroring `/resume` behavior)
- [ ] (Optional v2) `onSelectionChange` live preview panel

## 8. Resolved Questions
1. **Cap**: 50 sessions (MAX_SESSIONS). `SelectList.setFilter()` can narrow further client-side.
2. **Current session**: Shown with `(current)` suffix, pre-selected. Re-selecting is a no-op.
3. **Scope**: Project-only. No global (`listAll`) browsing for v1.

## 9. Implementation Notes (as-built)
- Package namespace is `@earendil-works/...` (not `@mariozechner/...` as in original docs).
- `getSelectListTheme()` is exported from `@earendil-works/pi-coding-agent` — used for themed picker styling.
- Title generation uses `SessionInfo.name` and `SessionInfo.firstMessage` directly (no session-open needed for title).
- Previews open each session via `SessionManager.open()` and walk `getBranch()` for the last meaningful message.
- `getBranch()` (no args) returns the current branch entries; this respects tree structure (abandoned branches excluded).
- Per-file errors (corrupted JSONL, etc.) are caught and fall back to `firstMessage` as preview.
