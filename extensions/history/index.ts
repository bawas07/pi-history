import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of recent sessions loaded at once. */
const MAX_SESSIONS = 50;

/** Hard cap on the primary (title) label length in the picker. */
const TITLE_MAX_LENGTH = 60;

/** Hard cap on the preview / description length. */
const PREVIEW_MAX_LENGTH = 80;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("history", {
    description: "Browse and resume past sessions for this project",
    handler: historyCommand,
  });
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function historyCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify("Loading sessions…", "info");

  try {
    const currentPath = ctx.sessionManager.getSessionFile();

    // 1. List all sessions for this project
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) {
      ctx.ui.notify("No sessions found for this project", "info");
      return;
    }

    // 2. Sort by most recently modified, cap
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const capped = sessions.slice(0, MAX_SESSIONS);

    // 3. Build picker items — open each session for the preview snippet
    const items: SelectItem[] = [];
    let currentIndex = -1;

    for (let i = 0; i < capped.length; i++) {
      const info = capped[i];
      const isCurrent = info.path === currentPath;

      const title = buildTitle(info);
      const relativeTime = formatRelativeTime(info.modified);
      const label = isCurrent
        ? `${title} · ${relativeTime} (current)`
        : `${title} · ${relativeTime}`;

      const preview = buildPreview(info.path, info.firstMessage);

      items.push({ value: info.path, label, description: preview });

      if (isCurrent) currentIndex = i;
    }

    // 4. Show the picker
    const chosenPath = await ctx.ui.custom<string | undefined>(
      (_tui, _theme, _keybindings, done) => {
        const list = new SelectList(
          items,
          Math.min(items.length, 15),
          getSelectListTheme(),
        );

        // Pre-select the current session so the user sees where they are
        if (currentIndex >= 0) {
          list.setSelectedIndex(currentIndex);
        }

        list.onSelect = (item: SelectItem) => {
          done(item.value);
        };
        list.onCancel = () => {
          done(undefined);
        };

        return list;
      },
      { overlay: true },
    );

    // 5. Act on selection
    if (chosenPath === undefined) {
      // User cancelled — no-op
      return;
    }

    if (chosenPath === currentPath) {
      // Re-selecting current session — no-op
      return;
    }

    await ctx.switchSession(chosenPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to load sessions: ${message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Title helpers
// ---------------------------------------------------------------------------

function buildTitle(info: { name?: string; firstMessage: string; modified: Date }): string {
  // 1. Explicit session name (set via /name or pi.setSessionName())
  if (info.name) {
    return truncateHard(info.name, TITLE_MAX_LENGTH);
  }

  // 2. Derive from the first user message (already available in SessionInfo)
  const cleaned = collapseWhitespace(info.firstMessage);
  if (cleaned) {
    return truncateHard(cleaned, TITLE_MAX_LENGTH);
  }

  // 3. Last-resort fallback
  return `Session · ${formatRelativeTime(info.modified)}`;
}

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

/**
 * Open the session file just long enough to grab the last meaningful message
 * on the current branch for the preview snippet.
 *
 * If opening or traversal fails for any reason, falls back to a truncated
 * version of the first message.
 */
function buildPreview(sessionPath: string, firstMessage: string): string {
  try {
    const sm = SessionManager.open(sessionPath);
    return extractPreviewFromSession(sm);
  } catch {
    // Corrupted session file or permission issue — use firstMessage as
    // fallback.
    const cleaned = collapseWhitespace(firstMessage);
    return cleaned
      ? truncateToSentence(cleaned, PREVIEW_MAX_LENGTH)
      : "(no messages)";
  }
}

function extractPreviewFromSession(sm: ReturnType<typeof SessionManager.open>): string {
  // Walk the *current* branch (from root to leaf) so we don't show content
  // from abandoned branches.
  const branch = sm.getBranch();

  let lastAssistantText = "";
  let lastUserText = "";

  // Walk backwards through the branch — stop at the first assistant message
  // with text content.
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;

    const msg = (entry as { message: { role: string; content: unknown } }).message;

    if (msg.role === "assistant" && !lastAssistantText) {
      lastAssistantText = extractMessageText(msg);
      if (lastAssistantText) break;
    }

    if (msg.role === "user" && !lastUserText) {
      lastUserText = extractMessageText(msg);
    }
  }

  const text = lastAssistantText || lastUserText || "";
  const cleaned = collapseWhitespace(stripBasicMarkdown(text));

  return cleaned
    ? truncateToSentence(cleaned, PREVIEW_MAX_LENGTH)
    : "(no messages)";
}

/**
 * Extract human-readable text from an AgentMessage's `content` field, which
 * can be a plain string or an array of `TextContent | ImageContent | …`.
 */
function extractMessageText(msg: { content: unknown }): string {
  const c = msg.content;

  // Simple string content (older user messages, some custom messages)
  if (typeof c === "string") return c;

  // Content-block array
  if (Array.isArray(c)) {
    return c
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text",
      )
      .map((block) => block.text)
      .join(" ");
  }

  return "";
}

// ---------------------------------------------------------------------------
// Text utility helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace / newlines into single spaces. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Hard truncate to `maxLen` chars, append ellipsis if cut. */
function truncateHard(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Truncate to `maxLen` chars, preferring a sentence boundary (`. `, `! `,
 * `? `, `.\n`) within the limit. Falls back to hard truncation if no
 * sentence boundary is found.
 */
function truncateToSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Look for the rightmost sentence boundary within the limit
  const chunk = text.slice(0, maxLen);
  const match = chunk.match(/.*[.!?](?:\s|$)/);
  if (match) {
    return match[0].trimEnd();
  }

  // No sentence boundary found — hard truncate
  return truncateHard(text, maxLen);
}

/**
 * Lightweight markdown stripping — removes common formatting tokens that
 * add noise to a one-line preview (bold, italic, code fences, links, etc.).
 */
function stripBasicMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]*)\*\*/g, "$1") // bold
    .replace(/__([^_]*)__/g, "$1") // bold (alt)
    .replace(/\*([^*]*)\*/g, "$1") // italic
    .replace(/_([^_]*)_/g, "$1") // italic (alt)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links [text](url)
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^[-*+]\s+/gm, "") // unordered list markers
    .replace(/^\d+\.\s+/gm, "") // ordered list markers
    .replace(/>\s+/g, ""); // blockquote markers
}

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

/**
 * Formats a Date as a human-friendly relative label.
 *
 *   < 1 min  →  "just now"
 *   < 1 hr   →  "Xm ago"
 *   < 24 hr  →  "Xh ago"
 *   < 48 hr  →  "yesterday"
 *   < 7 d    →  "Xd ago"
 *   ≥ 7 d    →  "Jun 14"
 *   diff yr  →  "Jun 14, 2025"
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;

  const shortMonth = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();

  if (date.getFullYear() !== now.getFullYear()) {
    return `${shortMonth} ${day}, ${date.getFullYear()}`;
  }

  return `${shortMonth} ${day}`;
}
