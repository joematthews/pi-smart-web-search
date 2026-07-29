// pi-smart-web-search -- registers one pi tool, `web_search`. See README.md for what it does.
// This file does the impure work: fetching, reading settings, and talking to pi. The markdown
// the model ends up reading is built by markdown.ts. Nothing here checks DuckDuckGo's output
// for missing titles, links or markup. That is deliberate: the extension cannot work at all
// without that endpoint, so a page that no longer parses means the extension is broken and
// should fail visibly rather than return half a result.

import { Type, type Static } from "typebox";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { fetch } from "wreq-js";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderToolResult,
  BATCH_FETCH_TOOL_NAME,
  FETCH_TOOL_NAME,
  type PageFetchResult,
  type QueryProgress,
  type QueryStatus,
  type SearchResultLink,
} from "./markdown.ts";

// =============================================================================
// Reading a page off the web
// =============================================================================

// How long to wait between fetches. Requesting faster than this earns an HTTP 202 challenge
// page from DDG instead of results, so the wait is what keeps searches working, not politeness.
// The random extra avoids sending requests on an exact interval.
const MIN_MS_BETWEEN_FETCHES = 1_000;
const EXTRA_RANDOM_WAIT_MS = 400;

let lastFetchStartedAt = 0;

async function waitBeforeNextFetch(): Promise<void> {
  const waitFor = MIN_MS_BETWEEN_FETCHES + Math.floor(Math.random() * EXTRA_RANDOM_WAIT_MS);
  const elapsed = Date.now() - lastFetchStartedAt;
  if (elapsed < waitFor) {
    await new Promise((resolve) => setTimeout(resolve, waitFor - elapsed));
  }
  lastFetchStartedAt = Date.now();
}

// Fetch a URL and extract its readable text. Never throws -- failures return `{ ok: false }`.
export async function fetchReadablePage(
  url: string,
  resultsPerQuery: number,
): Promise<PageFetchResult> {
  try {
    await waitBeforeNextFetch();
    const response = await fetch(url, {
      browser: "chrome_147",
      os: "windows",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      timeout: 12_000,
    });

    // 202 counts as ok, but DDG returns it for a rate-limit challenge page rather than results.
    if (response.status === 202) {
      return {
        ok: false,
        requestedUrl: url,
        error: "rate-limited by search engine (HTTP 202 soft-ban); wait ~60s before retrying",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        requestedUrl: url,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    // Redirects mean the final URL may differ from the requested one; extraction needs the final.
    const finalUrl = response.url;
    const page = parseHTML(await response.text()).document;

    // Trim first, then read, so the snippets and the link summary describe the same results.
    keepFirstResults(page, resultsPerQuery);
    const extraction = await Defuddle(page, finalUrl, { markdown: true, removeImages: true });

    return {
      ok: true,
      requestedUrl: url,
      finalUrl,
      title: extraction.title,
      readableText: extraction.content.trim(),
      links: readResultLinks(page),
    };
  } catch (caught) {
    return {
      ok: false,
      requestedUrl: url,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

// =============================================================================
// Picking the results out of a DuckDuckGo page
//
// A results page nests like this, ten times over:
//
//   <div class="result">
//     <h2 class="result__title"><a class="result__a" href="/l/?uddg=...">Page title</a></h2>
//     ...snippet...
//   </div>
// =============================================================================

function findAll(page: Document, selector: string) {
  return Array.from(page.querySelectorAll(selector));
}

// Delete every result past the first `count`, so only those results reach the reader. This is
// the single point where `resultsPerQuery` takes effect. Because it edits the page before
// anything reads it, one setting shrinks the snippets and the link summary by the same amount.
export function keepFirstResults(page: Document, count: number): void {
  for (const surplus of findAll(page, "div.result").slice(count)) {
    surplus.remove();
  }
}

// Every result link on the page, in DuckDuckGo's ranked order. Results are passed through
// exactly as ranked, repeats included: a URL returned twice is DDG saying so twice, and a URL
// shared by two queries is a relevance signal worth showing the model.
export function readResultLinks(page: Document): SearchResultLink[] {
  return findAll(page, "a.result__a").map((anchor) => ({
    title: anchor.textContent.trim(),
    url: unwrapRedirect(anchor.getAttribute("href") ?? ""),
  }));
}

// DDG hides each destination behind `/l/?uddg=<escaped-url>`; this gives back the real one.
function unwrapRedirect(href: string): string {
  const escapedUrl = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  return escapedUrl ? decodeURIComponent(escapedUrl) : href;
}

// =============================================================================
// The search engine and its one setting
// =============================================================================

// DuckDuckGo's no-JavaScript HTML endpoint, the only engine this extension supports. Reading
// results means reading DDG's own markup, so pointing this elsewhere returns a page with no
// links.
export const SEARCH_URL_TEMPLATE = "https://html.duckduckgo.com/html/?q={query}";

export function buildSearchUrl(query: string): string {
  return SEARCH_URL_TEMPLATE.replace("{query}", encodeURIComponent(query));
}

// How many results to keep per query. DDG returns 10 per page, so 10 is the maximum. Fewer
// results cost proportionally fewer tokens, which is the trade this setting exists to make. The
// default keeps the better-ranked half, which assumes results 6-10 rarely carry the answer.
// That holds for a factual lookup and holds less well for a broad survey.
export const DEFAULT_RESULTS_PER_QUERY = 5;
export const MIN_RESULTS_PER_QUERY = 1;
export const MAX_RESULTS_PER_QUERY = 10;

// Read `smartWebSearch.resultsPerQuery` from settings.json: the global file first, then the
// project one, which wins. A value outside 1-10 is pulled back into range, and a file that is
// missing or not valid JSON leaves the default in place.
//
//   "smartWebSearch": { "resultsPerQuery": 5 }
export function loadResultsPerQuery(projectDir: string): number {
  const globalFile = join(getAgentDir(), "settings.json"); // ~/.pi/agent/settings.json
  const projectFile = join(projectDir, ".pi", "settings.json");

  let resultsPerQuery = DEFAULT_RESULTS_PER_QUERY;

  // The project file is read second, so whatever it sets wins.
  for (const file of [globalFile, projectFile]) {
    const configured = readResultsPerQueryFrom(file);
    if (configured !== undefined) {
      resultsPerQuery = clamp(configured, MIN_RESULTS_PER_QUERY, MAX_RESULTS_PER_QUERY);
    }
  }

  return resultsPerQuery;
}

interface SettingsFile {
  smartWebSearch?: { resultsPerQuery?: unknown };
}

// The whole number one settings file asks for, or undefined if it does not ask for one.
function readResultsPerQueryFrom(file: string): number | undefined {
  let settings: SettingsFile;
  try {
    settings = JSON.parse(readFileSync(file, "utf-8")) as SettingsFile;
  } catch {
    return undefined; // No such file, or its contents are not valid JSON.
  }

  const configured = settings.smartWebSearch?.resultsPerQuery;
  if (typeof configured !== "number" || !Number.isFinite(configured)) return undefined;
  return Math.floor(configured);
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

// =============================================================================
// The progress card shown in pi's terminal while searches run
//
// One row per query: a status glyph, the query, and a right-aligned [ status ] badge.
// Expanding with Ctrl+O keeps the card and adds the answer underneath it.
// =============================================================================

// How each status looks: a theme color, and the character that starts its row.
const STATUS_STYLES: Record<QueryStatus, { color: ThemeColor; glyph: string }> = {
  queued: { color: "muted", glyph: "." },
  loading: { color: "accent", glyph: "." },
  done: { color: "success", glyph: "+" },
  error: { color: "error", glyph: "x" },
};

// How wide the status text inside a badge is padded to, so every badge is the same width.
const STATUS_BADGE_TEXT_WIDTH = 9;

// The status centered in a fixed-width badge, such as `[ done ]`.
export function formatStatusBadge(status: string): string {
  const spacesNeeded = Math.max(0, STATUS_BADGE_TEXT_WIDTH - status.length);
  const spacesBefore = Math.floor(spacesNeeded / 2);
  const spacesAfter = spacesNeeded - spacesBefore;
  return `[ ${" ".repeat(spacesBefore)}${status}${" ".repeat(spacesAfter)} ]`;
}

// Trim to the columns a terminal gives the text, which is not its number of characters: a CJK
// character occupies two columns, and an emoji is one glyph across two code units.
function truncate(text: string, roomAvailable: number): string {
  if (visibleWidth(text) <= roomAvailable) return text;
  return truncateToWidth(text, Math.max(1, roomAvailable));
}

// Width of the glyph column: the status character plus the space after it.
const GLYPH_COLUMN_WIDTH = 2;

// Build the progress card for a given terminal width. The header separator is a middle dot
// (U+00B7), matching pi-smart-fetch's batch_web_fetch card so the two tools read as a set. It
// is the one character here outside the US keyboard, and it sits in a string because it is
// drawn on screen rather than written in source. Spacing is worked out from plain text and the
// colors are added afterwards. Coloring first would count the invisible escape codes as width
// and push every badge out of line.
export function renderProgressCard(
  progressByQuery: QueryProgress[] | undefined,
  theme: Pick<Theme, "fg" | "bold">,
  terminalWidth: number,
): string {
  // A card restored from a session saved by an older version may have no progress to show.
  const entries = progressByQuery ?? [];
  const width = Math.max(24, terminalWidth || 80);

  const succeeded = entries.filter((entry) => entry.status === "done").length;
  const failed = entries.filter((entry) => entry.status === "error").length;

  // The tool is named by `renderCall`, which stays above this, so the card counts rather than
  // repeats it.
  const lines = [
    theme.fg(
      "muted",
      `${succeeded + failed}/${entries.length} done · ok ${succeeded} · err ${failed}`,
    ),
  ];

  for (const entry of entries) {
    const badge = formatStatusBadge(entry.status);
    const style = STATUS_STYLES[entry.status];

    // The query gets whatever room the glyph, the badge and at least one space leave behind.
    const roomForQuery = width - GLYPH_COLUMN_WIDTH - badge.length - 1;
    const query = truncate(entry.query, Math.max(1, roomForQuery));
    const gapBeforeBadge = Math.max(
      1,
      width - GLYPH_COLUMN_WIDTH - visibleWidth(query) - badge.length,
    );

    lines.push(
      `${theme.fg(style.color, style.glyph)} ${theme.fg("accent", query)}` +
        `${" ".repeat(gapBeforeBadge)}${theme.fg(style.color, badge)}`,
    );
  }

  return lines.join("\n");
}

// =============================================================================
// Tool registration
// =============================================================================

// A call with more than six queries fails validation before execute runs, so `maxItems` is the
// limit and the description below only has to explain how to choose within it. The const exists
// because `registerTool` needs `typeof` it to type the tool's details; inlining the schema
// loses that and `result.details` becomes `unknown`.
const searchParametersSchema = Type.Object({
  searches: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 6,
    description:
      "One to six search queries, each fetched as its own results page. Match the count to the " +
      "question: 1 for a narrow factual lookup, 2-3 for a topic with a few distinct angles, up to " +
      "6 for a broad or multi-part question. More queries is not better -- each one costs a fetch " +
      "and adds results to read, so only widen the set when the extra angles would actually change " +
      "the answer.",
  }),
});

export type WebSearchInput = Static<typeof searchParametersSchema>;

/** What the card needs to redraw itself. Optional because an older session may not carry it. */
export interface WebSearchDetails {
  progressByQuery?: QueryProgress[];
}

// Shown at session start, in the TUI only, when nothing can open result links. pi prefixes it
// with "Warning: ".
export const MISSING_FETCH_WARNING =
  "pi-smart-web-search needs a page-fetching tool to open search results, but neither " +
  `${FETCH_TOOL_NAME} nor ${BATCH_FETCH_TOOL_NAME} is registered. Install them with: ` +
  "pi install npm:pi-smart-fetch";

// Whether this session can open a result link at all. Drives the startup warning, nothing else.
export function hasFetchTools(toolNames: readonly string[]): boolean {
  return toolNames.includes(FETCH_TOOL_NAME) || toolNames.includes(BATCH_FETCH_TOOL_NAME);
}

export default function piSmartWebSearch(api: ExtensionAPI): void {
  // Checked at session start rather than on load, because by then every extension has registered
  // its tools and the order they loaded in no longer matters.
  api.on("session_start", (_event, ctx) => {
    if (!hasFetchTools(api.getAllTools().map((tool) => tool.name))) {
      ctx.ui.notify(MISSING_FETCH_WARNING, "warning");
    }
  });

  api.registerTool<typeof searchParametersSchema, WebSearchDetails>({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web and return each query's results as readable markdown -- title, URL and snippet " +
      "per result -- followed by a summary of every result link, to open with " +
      `${FETCH_TOOL_NAME} (a single page) or ${BATCH_FETCH_TOOL_NAME} (two or three). Call this ` +
      "whenever the answer depends on information that changes over time: latest versions, APIs, " +
      "prices, dates, events, release notes. Memory of these is often stale even when it feels certain.",
    promptSnippet: "Search the web for current or external information",
    promptGuidelines: [
      "Use web_search when current or external information would change the answer, then " +
        `${FETCH_TOOL_NAME} or ${BATCH_FETCH_TOOL_NAME} to open the few most relevant links it returns.`,
      "Match the number of web_search queries to the question: one for a narrow lookup, more only when the " +
        "extra angles would change the answer.",
    ],
    parameters: searchParametersSchema,

    // The one-line row shown the instant the call starts.
    renderCall(args, theme) {
      const queryCount = args.searches.length;
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("muted", `${queryCount} ${queryCount === 1 ? "query" : "queries"}`),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const resultsPerQuery = loadResultsPerQuery(ctx.cwd);

      const progressByQuery: QueryProgress[] = params.searches.map((query) => ({
        query,
        status: "queued",
        result: undefined,
      }));

      // Pushing progress on every change is what animates the card.
      const reportProgress = () => onUpdate?.({ content: [], details: { progressByQuery } });
      reportProgress();

      // One query at a time, so waitBeforeNextFetch actually spaces the requests out.
      for (const entry of progressByQuery) {
        entry.status = "loading";
        reportProgress();

        entry.result = await fetchReadablePage(buildSearchUrl(entry.query), resultsPerQuery);
        entry.status = entry.result.ok ? "done" : "error";
        reportProgress();
      }

      return {
        content: [{ type: "text", text: renderToolResult(progressByQuery) }],
        details: { progressByQuery },
      };
    },

    // The progress card, and underneath it -- once expanded with Ctrl+O -- the exact markdown
    // the model was given. The card stays either way, so expanding adds detail rather than
    // swapping the view out. Width-aware so the badge can right-align against the terminal
    // edge.
    renderResult(result, opts, theme) {
      const answer = result.content.map((block) => ("text" in block ? block.text : "")).join("");
      const container = new Container();
      const card = new Text("", 0, 0);

      // The card is the only part that depends on the width, so it is the only part rebuilt on
      // resize. Everything below it is added once.
      container.addChild(card);
      container.addChild(new Spacer(1));
      container.addChild(
        opts.expanded && answer
          ? // The tool result is markdown, so headings, links and the ordered list are rendered
            // as themselves, and a link becomes one the terminal can open.
            new Markdown(answer, 0, 0, getMarkdownTheme())
          : // The closing bracket is styled on its own, as pi's built-in tools style theirs:
            // `keyHint` ends with a reset, so a colour wrapped around the whole line stops there.
            new Text(
              theme.fg("muted", "... (") +
                keyHint("app.tools.expand", "to show results") +
                theme.fg("muted", ")"),
              0,
              0,
            ),
      );

      return {
        render(width) {
          card.setText(renderProgressCard(result.details.progressByQuery, theme, width));
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
      };
    },
  });
}
