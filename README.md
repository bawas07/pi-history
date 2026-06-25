# pi-history

A Pi extension that adds `/history` — a scannable session picker for your project. Browse past sessions with auto-generated titles, relative timestamps, and preview snippets. Pick one to resume instantly.

## Why

`/resume` lists sessions by raw file path or verbatim first message. Across projects with dozens of sessions, it's hard to tell them apart at a glance. `/history` makes each entry scannable:

- **Short generated title** — derived from `setSessionName()` or the first user message
- **Relative timestamp** — `"3h ago"`, `"yesterday"`, `"Jun 14"`
- **One-line preview** — last meaningful assistant reply, truncated at a sentence boundary
- **Current session** shown with a `(current)` suffix and pre-selected
- **Scope**: project-local only (sessions for `cwd`), sorted most recent first

## Install

```bash
# In your Pi project
pi install pi-history
```

Or clone manually into your project's `extensions/` directory.

Requires **Pi v0.79+** (depends on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`).

## Usage

Type `/history` in any Pi session. A picker opens with your project's recent sessions:

```
┌──────────────────────────────────────────────────────────┐
│ Fix the login redirect bug · 3h ago                      │
│   Let me trace through the auth middleware to see where…  │
│                                                          │
│ Add rate limiting to API routes · yesterday               │
│   Here's the middleware implementation using token bucket…│
│                                                          │
│ Set up CI pipeline · Jun 14 (current)                    │
│   The workflow file is in .github/workflows/ci.yml and…   │
└──────────────────────────────────────────────────────────┘
```

- **↑↓** navigate, **Enter** to resume a session, **Esc** to cancel
- Selecting the current session is a no-op
- Type to filter (fuzzy match powered by `SelectList.setFilter()`)
- Capped at 50 most recent sessions for performance

## How it works

1. `SessionManager.list(ctx.cwd)` lists all sessions for the current project
2. Titles come directly from `SessionInfo.name` / `SessionInfo.firstMessage` (no file open needed)
3. Previews open each session and walk `getBranch()` — the current tree branch — to find the last meaningful assistant message
4. Markdown is stripped, text is collapsed and truncated at sentence boundaries for clean display
5. Malformed session files are caught gracefully and fall back to the first message as preview

## Structure

```
extensions/history/index.ts    # Single-file extension (~200 lines)
```

No build step needed — `tsconfig.json` uses `noEmit: true` and Pi loads TypeScript directly.

## License

MIT © Zoych
