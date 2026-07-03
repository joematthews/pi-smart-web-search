/**
 * pi-smart-web-search — a pi extension that adds one tool: `web_search`.
 *
 * What it does, in plain terms:
 *   1. The model hands us one or more search queries.
 *   2. For each query, we build a DDG search URL, fetch that results page,
 *      and extract it into clean, readable text (the same fetch + extract pipeline
 *      pi-smart-fetch uses: wreq-js to fetch, linkedom + Defuddle to extract).
 *   3. We hand the model the extracted results, led by a short "# Next step"
 *      instruction telling it to open the best links with `batch_web_fetch`.
 *
 * So the model decides which links are worth reading (no junk auto-pulled into its
 * context), and the "go read them" nudge sits right next to the links.
 *
 * Local install (no npm registry):
 *   1. `cd` into this folder and run `npm install` (pulls wreq-js, defuddle, linkedom).
 *   2. Add this folder's absolute path to the "packages" list in ~/.pi/agent/settings.json.
 *   3. Restart pi. (Install pi-smart-fetch too — web_search hands off to its batch_web_fetch.)
 */

import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fetch } from "wreq-js";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// 1. Fetching and extracting a page
//    Fetch a URL like a real browser, then pull out the readable text as markdown.
// =============================================================================

/** How we fetch: impersonate a current Chrome on Windows, with a sane timeout. */
const BROWSER_FETCH_OPTIONS = {
  browser: "chrome_140" as const,
  os: "windows" as const,
  timeoutMs: 12_000,
  acceptHeader: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  acceptLanguageHeader: "en-US,en;q=0.9",
};

/** The outcome of fetching one URL: either readable text, or a reason it failed. */
export type PageFetchResult =
  | { ok: true; requestedUrl: string; finalUrl: string; title: string; readableText: string }
  | { ok: false; requestedUrl: string; error: string };

/** Fetch a single URL and extract its readable text. Never throws — failures come back as `{ ok: false }`. */
export async function fetchReadablePage(url: string): Promise<PageFetchResult> {
  try {
    const response = await fetch(url, {
      browser: BROWSER_FETCH_OPTIONS.browser,
      os: BROWSER_FETCH_OPTIONS.os,
      headers: {
        Accept: BROWSER_FETCH_OPTIONS.acceptHeader,
        "Accept-Language": BROWSER_FETCH_OPTIONS.acceptLanguageHeader,
      },
      redirect: "follow",
      timeout: BROWSER_FETCH_OPTIONS.timeoutMs,
    });

    if (!response.ok) {
      return {
        ok: false,
        requestedUrl: url,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    // The URL may differ after redirects; use the final one for extraction context.
    const finalUrl = response.url;
    const { document } = parseHTML(await response.text());
    const extraction = await Defuddle(document, finalUrl, { markdown: true, removeImages: true });

    return {
      ok: true,
      requestedUrl: url,
      finalUrl,
      title: extraction.title,
      readableText: extraction.content.trim(),
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
// 2. Settings
//    Read from a `smartWebSearch` object in settings.json (global, then per-project
//    which overrides). Both keys are optional — the defaults below are used otherwise.
//
//      "smartWebSearch": {
//        "searchUrl": "https://html.duckduckgo.com/html/?q={query}",
//        "maxChars": 10000
//      }
// =============================================================================

/** Default search engine: DDG's no-JavaScript HTML endpoint (`{query}` is filled in per search). */
export const DEFAULT_SEARCH_URL_TEMPLATE = "https://html.duckduckgo.com/html/?q={query}";

/**
 * Safety cap on how much extracted text we return per query. A DDG results page
 * through this pipeline measures ~6,400–7,900 characters, so 10,000 (the ~7,900 max plus
 * ~25% headroom) never truncates DDG — it only protects against a different,
 * larger engine when someone swaps `searchUrl`.
 */
const DEFAULT_MAX_CHARS_PER_QUERY = 10_000;

interface Settings {
  searchUrlTemplate: string;
  maxCharsPerQuery: number;
}

/** Load settings, applying global then per-project overrides. Bad/missing files are ignored. */
function loadSettings(projectDir: string): Settings {
  const settings: Settings = {
    searchUrlTemplate: DEFAULT_SEARCH_URL_TEMPLATE,
    maxCharsPerQuery: DEFAULT_MAX_CHARS_PER_QUERY,
  };

  const settingsFiles = [
    join(getAgentDir(), "settings.json"), // global: ~/.pi/agent/settings.json
    join(projectDir, ".pi", "settings.json"), // per-project: ./.pi/settings.json (wins)
  ];

  for (const file of settingsFiles) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
      const section = (parsed as { smartWebSearch?: unknown }).smartWebSearch;
      if (typeof section === "object" && section !== null) {
        const { searchUrl, maxChars } = section as { searchUrl?: unknown; maxChars?: unknown };
        // A search URL is only accepted if it has the {query} placeholder to fill in.
        if (typeof searchUrl === "string" && searchUrl.includes("{query}")) {
          settings.searchUrlTemplate = searchUrl;
        }
        if (typeof maxChars === "number" && maxChars > 0) {
          settings.maxCharsPerQuery = Math.floor(maxChars);
        }
      }
    } catch {
      // File missing or not valid JSON → keep whatever we have so far.
    }
  }

  return settings;
}

/** Turn a query into a full search URL by filling the `{query}` placeholder. */
export function buildSearchUrl(template: string, query: string): string {
  return template.replace("{query}", encodeURIComponent(query));
}

// =============================================================================
// 3. The tool: parameters, progress tracking, and the text we return to the model
// =============================================================================

/** The tool takes a list of queries — plural on purpose, to encourage covering a topic from several angles. */
const searchParametersSchema = Type.Object({
  searches: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "One or more search queries to run together. Pass several queries at once to cover a topic from multiple angles in a single call.",
  }),
});
type SearchParameters = Static<typeof searchParametersSchema>;

/** Where each query is in its lifecycle, plus its result once it finishes. Drives the live progress card. */
interface QueryProgress {
  query: string;
  status: "queued" | "loading" | "done" | "error";
  result: PageFetchResult | undefined;
}

/**
 * The instruction block we put at the top of every result, telling the model these are
 * search results (links + snippets) and what to do next: open the best ones, then answer.
 */
const FOLLOW_UP_INSTRUCTIONS = [
  "# Next step: evaluate the results",
  "",
  "These are previews — brief, and sometimes out of date. If they don't fully answer your question, read the full pages:",
  "1. Choose the most relevant URLs below.",
  "2. Use the `batch_web_fetch` tool to fetch those pages.",
  "3. Answer from what you read.",
  "",
].join("\n");

/**
 * Clean up the result links in extracted markdown for whichever search engine produced it.
 *
 * Each engine mangles links its own way, and the cleanup is too engine-specific to express as a
 * single shared regex — so we dispatch to a per-engine parser keyed off the search URL. Engines we
 * don't have a parser for fall through unchanged (raw links shown as-is).
 */
export function cleanSearchResultLinks(markdown: string, searchUrlTemplate: string): string {
  if (searchUrlTemplate.includes("duckduckgo.com")) {
    return parseDdgLinks(markdown);
  }
  return markdown;
}

/**
 * DDG wraps every result link in a redirect: `https://duckduckgo.com/l/?uddg=<real-url>&rut=…`,
 * where the real destination is percent-encoded in the `uddg` query parameter. Left as-is, the model
 * would hand these opaque redirect URLs to batch_web_fetch. This unwraps them back to the real URL
 * everywhere they appear in the extracted markdown (both protocol-relative and absolute forms).
 */
export function parseDdgLinks(markdown: string): string {
  // Matches the whole redirect URL — scheme optional (DDG often emits protocol-relative links) —
  // captures the `uddg` value, and consumes any trailing params (e.g. `&rut=…`) so nothing dangles.
  const redirectPattern =
    /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;

  return markdown.replace(redirectPattern, (whole: string, encodedTarget: string) => {
    try {
      return decodeURIComponent(encodedTarget);
    } catch {
      return whole; // Malformed encoding → leave the original link untouched.
    }
  });
}

/** Build the full text we hand back to the model: the follow-up instructions, then each query's results. */
function formatResultsForModel(
  progressByQuery: QueryProgress[],
  maxCharsPerQuery: number,
  searchUrlTemplate: string,
): string {
  const sections = [FOLLOW_UP_INSTRUCTIONS];

  for (const entry of progressByQuery) {
    sections.push(`## Query: "${entry.query}"`);

    if (!entry.result?.ok) {
      const reason = entry.result ? entry.result.error : "unknown";
      sections.push(`_search failed: ${reason}_\n`);
      continue;
    }

    const fullText = cleanSearchResultLinks(entry.result.readableText || "", searchUrlTemplate);
    const cappedText =
      fullText.length > maxCharsPerQuery
        ? fullText.slice(0, maxCharsPerQuery) + "\n…(truncated)"
        : fullText;
    sections.push(`${cappedText || "_no content extracted_"}\n`);
  }

  return sections.join("\n");
}

// =============================================================================
// 4. The progress card (what shows in pi's terminal UI while searches run)
//    One row per query: a status glyph, the query text, and a right-aligned
//    [ status ] badge — matching batch_web_fetch's look.
// =============================================================================

/** Number of characters between the brackets of a status badge; the label is centered within it. */
const STATUS_BADGE_INNER_WIDTH = 9;

const labelForStatus = (status: string) => status; // "queued" | "loading" | "done" | "error"
const colorForStatus = (status: string) =>
  status === "done"
    ? "success"
    : status === "error"
      ? "error"
      : status === "loading"
        ? "accent"
        : "muted";
const glyphForStatus = (status: string) =>
  status === "done" ? "✓" : status === "error" ? "✗" : "·";

/** Render a fixed-width, centered status badge like `[   done    ]`. */
function formatStatusBadge(status: string): string {
  const label = labelForStatus(status);
  const totalPadding = Math.max(0, STATUS_BADGE_INNER_WIDTH - label.length);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return `[${" ".repeat(leftPadding + 1)}${label}${" ".repeat(rightPadding + 1)}]`;
}

/**
 * Build the progress card text for a given terminal width, right-aligning each badge.
 * Alignment math uses plain-text lengths; colors (which add invisible escape codes) are
 * applied only after the spacing is computed, so they don't throw off the layout.
 */
export function renderProgressCard(
  progressByQuery: QueryProgress[] | undefined,
  theme: Theme,
  terminalWidth: number,
): string {
  const width = Math.max(24, terminalWidth || 80);

  progressByQuery = progressByQuery ?? [];

  const total = progressByQuery.length;
  const finished = progressByQuery.filter(
    (q) => q.status === "done" || q.status === "error",
  ).length;
  const succeeded = progressByQuery.filter((q) => q.status === "done").length;
  const failed = progressByQuery.filter((q) => q.status === "error").length;

  // Header line, e.g. "web_search 2/3 done · ok 2 · err 0"
  const lines = [
    theme.fg("toolTitle", theme.bold("web_search ")) +
      theme.fg("muted", `${finished}/${total} done · ok ${succeeded} · err ${failed}`),
  ];

  for (const entry of progressByQuery) {
    const badge = formatStatusBadge(entry.status);
    const glyphAndSpaceWidth = 2; // the status glyph plus the space after it

    // Truncate the query if the row would otherwise overflow the terminal width.
    const maxQueryWidth = Math.max(1, width - glyphAndSpaceWidth - badge.length - 1);
    const query =
      entry.query.length > maxQueryWidth
        ? entry.query.slice(0, Math.max(1, maxQueryWidth - 1)) + "…"
        : entry.query;

    // Spaces between the query and the badge so the badge lands flush against the right edge.
    const gap = Math.max(1, width - glyphAndSpaceWidth - query.length - badge.length);

    const glyph = theme.fg(colorForStatus(entry.status), glyphForStatus(entry.status));
    const coloredBadge = theme.fg(colorForStatus(entry.status), badge);
    lines.push(`${glyph} ${theme.fg("accent", query)}${" ".repeat(gap)}${coloredBadge}`);
  }

  return lines.join("\n");
}

// =============================================================================
// 5. Concurrency helper
//    Run an async function over a list, but only so many at a time.
// =============================================================================

async function runWithConcurrencyLimit<Item, Result>(
  items: Item[],
  maxInFlight: number,
  run: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array<Result>(items.length);
  let nextIndex = 0;

  // Each worker pulls the next unclaimed item until the list is exhausted.
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item, index);
    }
  };

  const workerCount = Math.min(maxInFlight, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** Run at most this many query fetches at once. */
const MAX_CONCURRENT_SEARCHES = 1;

// =============================================================================
// 6. Tool registration
// =============================================================================

/**
 * Minimal local typings for the pi extension surface this tool touches. pi supplies the
 * `api` and `theme` objects at runtime and does not export their types, so we declare just
 * the members we use — enough to keep the boundary type-safe without depending on internals.
 */
interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface RenderedComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface ToolUpdate {
  content: unknown[];
  details: { progressByQuery: QueryProgress[] };
}

interface ToolResultPayload {
  content: { type: "text"; text: string }[];
  details: { progressByQuery: QueryProgress[] };
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  renderCall?: (args: SearchParameters, theme: Theme) => Text;
  execute: (
    toolCallId: string,
    params: SearchParameters,
    signal: AbortSignal | undefined,
    onUpdate?: (update: ToolUpdate) => void,
    ctx?: { cwd?: string },
  ) => Promise<ToolResultPayload>;
  renderResult?: (result: ToolResultPayload, opts: unknown, theme: Theme) => RenderedComponent;
}

interface PiToolApi {
  registerTool(definition: ToolDefinition): void;
}

export default function piSmartWebSearch(api: PiToolApi): void {
  api.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. Call this whenever current or external information would change your answer — " +
      "latest versions, APIs, prices, dates, events, or anything you can't verify from " +
      "memory. Returns ranked result pages to follow up on.",
    promptSnippet: "web_search(searches: string[]): batch web search; returns ranked result pages",
    promptGuidelines: [
      "Use web_search to find sources — pass several optimized queries at once to cover a topic from multiple angles.",
    ],
    parameters: searchParametersSchema,

    // The one-line "web_search N queries" shown the instant the call starts.
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
      const { searchUrlTemplate, maxCharsPerQuery } = loadSettings(ctx?.cwd ?? process.cwd());

      // Start every query as "queued"; we update each one as it runs.
      const progressByQuery: QueryProgress[] = params.searches.map((query) => ({
        query: query,
        status: "queued",
        result: undefined,
      }));

      // Push the current progress to pi's UI so the card animates live.
      const reportProgress = () => onUpdate?.({ content: [], details: { progressByQuery } });
      reportProgress();

      await runWithConcurrencyLimit(
        params.searches,
        MAX_CONCURRENT_SEARCHES,
        async (query, index) => {
          const entry = progressByQuery[index];
          if (entry === undefined) return;

          entry.status = "loading";
          reportProgress();

          entry.result = await fetchReadablePage(buildSearchUrl(searchUrlTemplate, query));
          entry.status = entry.result.ok ? "done" : "error";
          reportProgress();
        },
      );

      return {
        content: [
          {
            type: "text",
            text: formatResultsForModel(progressByQuery, maxCharsPerQuery, searchUrlTemplate),
          },
        ],
        details: { progressByQuery },
      };
    },

    // Width-aware (returns a `render(width)` component) so the [ status ] badge can right-align,
    // the same approach batch_web_fetch uses.
    renderResult(result, _opts, theme) {
      const progressByQuery = result.details.progressByQuery;
      const text = new Text("", 0, 0);
      return {
        render(width) {
          text.setText(renderProgressCard(progressByQuery, theme, width));
          return text.render(width);
        },
        invalidate() {
          text.invalidate();
        },
      };
    },
  });
}
