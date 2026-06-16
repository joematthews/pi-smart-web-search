/**
 * pi-smart-web-search — a pi extension that adds one tool: `web_search`.
 *
 * What it does, in plain terms:
 *   1. The model hands us one or more search queries.
 *   2. For each query, we build a DuckDuckGo search URL, fetch that results page,
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
    const finalUrl = response.url ?? url;
    const { document } = parseHTML(await response.text());
    const extraction = await Defuddle(document, finalUrl, { markdown: true, removeImages: true });

    return {
      ok: true,
      requestedUrl: url,
      finalUrl,
      title: extraction.title ?? "",
      readableText: (extraction.content ?? "").trim(),
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

/** Default search engine: DuckDuckGo's no-JavaScript HTML endpoint (`{query}` is filled in per search). */
export const DEFAULT_SEARCH_URL_TEMPLATE = "https://html.duckduckgo.com/html/?q={query}";

/**
 * Safety cap on how much extracted text we return per query. A DuckDuckGo results page
 * through this pipeline measures ~6,400–7,900 characters, so 10,000 (the ~7,900 max plus
 * ~25% headroom) never truncates DuckDuckGo — it only protects against a different,
 * larger engine when someone swaps `searchUrl`.
 */
const DEFAULT_MAX_CHARS_PER_QUERY = 10_000;

type Settings = {
  searchUrlTemplate: string;
  maxCharsPerQuery: number;
};

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
      const section = JSON.parse(readFileSync(file, "utf-8")).smartWebSearch;
      if (section && typeof section === "object") {
        // A search URL is only accepted if it has the {query} placeholder to fill in.
        if (typeof section.searchUrl === "string" && section.searchUrl.includes("{query}")) {
          settings.searchUrlTemplate = section.searchUrl;
        }
        if (typeof section.maxChars === "number" && section.maxChars > 0) {
          settings.maxCharsPerQuery = Math.floor(section.maxChars);
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
  searches: Type.Array(Type.Object({ query: Type.String({ description: "A search query." }) }), {
    minItems: 1,
    description:
      "One or more search queries to run together. Pass several at once to cover a topic from multiple angles in a single call.",
  }),
});
type SearchParameters = Static<typeof searchParametersSchema>;

/** Where each query is in its lifecycle, plus its result once it finishes. Drives the live progress card. */
type QueryProgress = {
  query: string;
  status: "queued" | "loading" | "done" | "error";
  result: PageFetchResult | undefined;
};

/**
 * The instruction block we put at the top of every result, telling the model these are
 * search results (links + snippets) and what to do next: open the best ones, then answer.
 */
const FOLLOW_UP_INSTRUCTIONS = [
  "# Next step: read the best results",
  "",
  "These are search results — to answer well, open the most relevant pages; don't rely on snippets alone.",
  "1. Review the results below and choose the most relevant URLs.",
  "2. Call batch_web_fetch on those URLs to read the full pages.",
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
function cleanSearchResultLinks(markdown: string, searchUrlTemplate: string): string {
  if (searchUrlTemplate.includes("duckduckgo.com")) {
    return parseDuckDuckGoLinks(markdown);
  }
  return markdown;
}

/**
 * DuckDuckGo wraps every result link in a redirect: `https://duckduckgo.com/l/?uddg=<real-url>&rut=…`,
 * where the real destination is percent-encoded in the `uddg` query parameter. Left as-is, the model
 * would hand these opaque redirect URLs to batch_web_fetch. This unwraps them back to the real URL
 * everywhere they appear in the extracted markdown (both protocol-relative and absolute forms).
 */
export function parseDuckDuckGoLinks(markdown: string): string {
  // Matches the whole redirect URL — scheme optional (DDG often emits protocol-relative links) —
  // captures the `uddg` value, and consumes any trailing params (e.g. `&rut=…`) so nothing dangles.
  const redirectPattern =
    /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;

  return markdown.replace(redirectPattern, (whole, encodedTarget) => {
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

    if (!entry.result || entry.result.ok === false) {
      const reason = entry.result?.ok === false ? entry.result.error : "unknown";
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
function renderProgressCard(
  progressByQuery: QueryProgress[],
  theme: any,
  terminalWidth: number,
): string {
  const width = Math.max(24, terminalWidth || 80);

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
  const results: Result[] = new Array(items.length);
  let nextIndex = 0;

  // Each worker pulls the next unclaimed item until the list is exhausted.
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await run(items[index], index);
    }
  };

  const workerCount = Math.min(maxInFlight, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** Run at most this many query fetches at once. */
const MAX_CONCURRENT_SEARCHES = 5;

// =============================================================================
// 6. Tool registration
// =============================================================================

export default function piSmartWebSearch(api: any) {
  api.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. Call this whenever current or external information would change your answer — " +
      "latest versions, APIs, prices, dates, events, or anything you can't verify from " +
      "memory. Returns ranked result pages to follow up on.",
    promptSnippet: "web_search(searches[{query}]): batch web search; returns ranked result pages",
    promptGuidelines: [
      "Use web_search to find sources — pass several queries at once to cover a topic from multiple angles.",
    ],
    parameters: searchParametersSchema,

    // The one-line "web_search N queries" shown the instant the call starts.
    renderCall(args: any, theme: any) {
      const queryCount = Array.isArray(args?.searches) ? args.searches.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("muted", `${queryCount} ${queryCount === 1 ? "query" : "queries"}`),
        0,
        0,
      );
    },

    async execute(
      _toolCallId: string,
      params: SearchParameters,
      _signal: AbortSignal | undefined,
      onUpdate?: (update: { content: any[]; details: any }) => void,
      ctx?: { cwd?: string },
    ) {
      const { searchUrlTemplate, maxCharsPerQuery } = loadSettings(ctx?.cwd ?? process.cwd());

      // Start every query as "queued"; we update each one as it runs.
      const progressByQuery: QueryProgress[] = params.searches.map((search) => ({
        query: search.query,
        status: "queued",
        result: undefined,
      }));

      // Push the current progress to pi's UI so the card animates live.
      const reportProgress = () => onUpdate?.({ content: [], details: { progressByQuery } });
      reportProgress();

      await runWithConcurrencyLimit(
        params.searches,
        MAX_CONCURRENT_SEARCHES,
        async (search, index) => {
          progressByQuery[index].status = "loading";
          reportProgress();

          progressByQuery[index].result = await fetchReadablePage(
            buildSearchUrl(searchUrlTemplate, search.query),
          );
          progressByQuery[index].status = progressByQuery[index].result!.ok ? "done" : "error";
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
    renderResult(result: any, _opts: any, theme: any) {
      const progressByQuery: QueryProgress[] = result?.details?.progressByQuery ?? [];
      const text = new Text("", 0, 0);
      return {
        render(width: number) {
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
