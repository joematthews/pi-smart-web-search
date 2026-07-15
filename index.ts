/**
 * pi-smart-web-search -- a pi extension that adds one tool: `web_search`.
 *
 * What it does, in plain terms:
 *   1. The model hands us one or more search queries.
 *   2. For each query, we build a DDG search URL, fetch that results page,
 *      and extract it into clean, readable text (the same fetch + extract pipeline
 *      pi-smart-fetch uses: wreq-js to fetch, linkedom + Defuddle to extract).
 *   3. We hand the model the extracted results, followed by a short "# Next step" menu of the
 *      result links (grouped by query) to open and read the full pages.
 *
 * So the model decides which links are worth reading (no junk auto-pulled into its
 * context), and the "go read them" nudge sits right next to the links.
 *
 * Local install (no npm registry):
 *   1. `cd` into this folder and run `npm install` (pulls wreq-js, defuddle, linkedom).
 *   2. Add this folder's absolute path to the "packages" list in ~/.pi/agent/settings.json.
 *   3. Restart pi. (pi-smart-fetch is recommended -- it adds a tool to open the result links --
 *      but web_search does not depend on it.)
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

/** Global minimum gap between fetches (plus jitter) to stay under the search endpoint's rate limit. */
const MIN_MS_BETWEEN_FETCHES = 1_500;
const FETCH_JITTER_MS = 400;
let lastFetchAt = 0;
async function throttleBeforeFetch(): Promise<void> {
  const target = MIN_MS_BETWEEN_FETCHES + Math.floor(Math.random() * FETCH_JITTER_MS);
  const sinceLast = Date.now() - lastFetchAt;
  if (sinceLast < target) {
    await new Promise((resolve) => setTimeout(resolve, target - sinceLast));
  }
  lastFetchAt = Date.now();
}

/** Max result links pulled from each search page for the end-of-results "next step" menu. */
const MAX_LINKS_PER_QUERY = 4;

/** A single search result: its title and the (redirect-unwrapped) destination URL. */
export interface SearchResultLink {
  title: string;
  url: string;
}

/** The outcome of fetching one URL: readable text plus any extracted result links, or a failure reason. */
export type PageFetchResult =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      title: string;
      readableText: string;
      links: SearchResultLink[];
    }
  | { ok: false; requestedUrl: string; error: string };

/** Fetch a single URL and extract its readable text. Never throws -- failures come back as `{ ok: false }`. */
export async function fetchReadablePage(url: string): Promise<PageFetchResult> {
  try {
    await throttleBeforeFetch();
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

    // 202 is a 2xx (response.ok is true), but the endpoint returns it for a rate-limit challenge page.
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

    // The URL may differ after redirects; use the final one for extraction context.
    const finalUrl = response.url;
    const html = await response.text();
    const { document } = parseHTML(html);
    const extraction = await Defuddle(document, finalUrl, { markdown: true, removeImages: true });

    return {
      ok: true,
      requestedUrl: url,
      finalUrl,
      title: extraction.title,
      readableText: extraction.content.trim(),
      links: extractResultLinks(html),
    };
  } catch (caught) {
    return {
      ok: false,
      requestedUrl: url,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/**
 * Pull the ranked result links from a DDG results page: the `a.result__a` anchors, each redirect
 * unwrapped to its real URL, deduped, capped at MAX_LINKS_PER_QUERY. A non-DDG page has no such
 * anchors, so this returns []. Exported for testing.
 */
export function extractResultLinks(html: string): SearchResultLink[] {
  const { document } = parseHTML(html);
  const anchors = Array.from(document.querySelectorAll("a.result__a")) as unknown as {
    getAttribute(name: string): string | null;
    textContent: string | null;
  }[];
  const links: SearchResultLink[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") ?? "";
    const encoded = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    let url = href;
    if (encoded) {
      try {
        url = decodeURIComponent(encoded);
      } catch {
        url = href;
      }
    }
    const title = (anchor.textContent ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ title: title || url, url });
    if (links.length >= MAX_LINKS_PER_QUERY) break;
  }
  return links;
}

// =============================================================================
// 2. Settings
//    Read from a `smartWebSearch` object in settings.json (global, then per-project
//    which overrides). Both keys are optional -- the defaults below are used otherwise.
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
 * through this pipeline measures ~6,400-7,900 characters, so 10,000 (the ~7,900 max plus
 * ~25% headroom) never truncates DDG -- it only protects against a different,
 * larger engine when someone swaps `searchUrl`.
 */
const DEFAULT_MAX_CHARS_PER_QUERY = 10_000;

interface Settings {
  searchUrlTemplate: string;
  maxCharsPerQuery: number;
}

/** Load settings, applying global then per-project overrides. Bad/missing files are ignored. */
export function loadSettings(projectDir: string): Settings {
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
      // File missing or not valid JSON -> keep whatever we have so far.
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

/** The tool takes a list of queries -- plural on purpose, to encourage covering a topic from several angles. */
const searchParametersSchema = Type.Object({
  searches: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "One or more search queries to run together. Pass a few focused queries to cover a topic from multiple angles in a single call.",
  }),
});
type SearchParameters = Static<typeof searchParametersSchema>;

/** Hard ceiling on queries per call; excess is silently dropped (counted in the card, invisible to the model). */
const MAX_QUERIES = 5;

/** Where each query is in its lifecycle, plus its result once it finishes. Drives the live progress card. */
export interface QueryProgress {
  query: string;
  status: "queued" | "loading" | "done" | "error";
  result: PageFetchResult | undefined;
}

/** Header for the end-of-results "next step" menu -- placed just before generation, where it lands hardest. */
const NEXT_STEP_HEADER = [
  "# Fetch the most relevant links",
  "",
  "Read the full pages below before answering -- these previews are brief and may be out of date. " +
    "Skip fetching only if the previews already fully answer the question.",
  "",
].join("\n");

/**
 * The action menu appended after the results: a nested list of each query and its top result links.
 * A link relevant to several queries simply repeats across the list, leaving the cross-query
 * relevance for the model to read off. Sits at the end, closest to where the model generates.
 * Empty when there are no links.
 */
export function renderNextStepMenu(progressByQuery: QueryProgress[]): string {
  const lines: string[] = [];
  progressByQuery.forEach((entry, index) => {
    if (!entry.result?.ok || entry.result.links.length === 0) return;
    const queryNumber = index + 1;
    lines.push(`${queryNumber}. "${entry.query}"`);
    entry.result.links.forEach((link, linkIndex) => {
      lines.push(`   ${queryNumber}.${linkIndex + 1} [${link.title}](${link.url})`);
    });
  });

  return lines.length ? `${NEXT_STEP_HEADER}\n${lines.join("\n")}` : "";
}

/**
 * Clean up the result links in extracted markdown for whichever search engine produced it.
 *
 * Each engine mangles links its own way, and the cleanup is too engine-specific to express as a
 * single shared regex -- so we dispatch to a per-engine parser keyed off the search URL. Engines we
 * don't have a parser for fall through unchanged (raw links shown as-is).
 */
export function cleanSearchResultLinks(markdown: string, searchUrlTemplate: string): string {
  if (searchUrlTemplate.includes("duckduckgo.com")) {
    return parseDdgLinks(markdown);
  }
  return markdown;
}

/**
 * DDG wraps every result link in a redirect: `https://duckduckgo.com/l/?uddg=<real-url>&rut=...`,
 * where the real destination is percent-encoded in the `uddg` query parameter. Left as-is, the model
 * would hand these opaque redirect URLs to batch_web_fetch. This unwraps them back to the real URL
 * everywhere they appear in the extracted markdown (both protocol-relative and absolute forms).
 */
export function parseDdgLinks(markdown: string): string {
  // Matches the whole redirect URL -- scheme optional (DDG often emits protocol-relative links) --
  // captures the `uddg` value, and consumes any trailing params (e.g. `&rut=...`) so nothing dangles.
  const redirectPattern =
    /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;

  return markdown.replace(redirectPattern, (whole: string, encodedTarget: string) => {
    try {
      return decodeURIComponent(encodedTarget);
    } catch {
      return whole; // Malformed encoding -> leave the original link untouched.
    }
  });
}

/** Build the full text we hand back to the model: each query's results, then the "next step" link menu. */
export function formatResultsForModel(
  progressByQuery: QueryProgress[],
  maxCharsPerQuery: number,
  searchUrlTemplate: string,
): string {
  const sections: string[] = [];

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
        ? fullText.slice(0, maxCharsPerQuery) + "\n...(truncated)"
        : fullText;
    sections.push(`${cappedText || "_no content extracted_"}\n`);
  }

  const menu = renderNextStepMenu(progressByQuery);
  if (menu) sections.push(menu);

  return sections.join("\n");
}

// =============================================================================
// 4. The progress card (what shows in pi's terminal UI while searches run)
//    One row per query: a status glyph, the query text, and a right-aligned
//    [ status ] badge -- matching batch_web_fetch's look.
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
  status === "done" ? "+" : status === "error" ? "x" : ".";

/** Render a fixed-width, centered status badge like `[   done    ]`. */
export function formatStatusBadge(status: string): string {
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
  progressByQuery: QueryProgress[],
  dropped: number,
  theme: Theme,
  terminalWidth: number,
): string {
  const width = Math.max(24, terminalWidth || 80);

  const total = progressByQuery.length;
  const finished = progressByQuery.filter(
    (q) => q.status === "done" || q.status === "error",
  ).length;
  const succeeded = progressByQuery.filter((q) => q.status === "done").length;
  const failed = progressByQuery.filter((q) => q.status === "error").length;

  // Header line, e.g. "web_search 2/3 done | ok 2 | err 0"; `| drop N` appears only when queries were capped.
  const dropSuffix = dropped > 0 ? ` | drop ${dropped}` : "";
  const lines = [
    theme.fg("toolTitle", theme.bold("web_search ")) +
      theme.fg("muted", `${finished}/${total} done | ok ${succeeded} | err ${failed}${dropSuffix}`),
  ];

  for (const entry of progressByQuery) {
    const badge = formatStatusBadge(entry.status);
    const glyphAndSpaceWidth = 2; // the status glyph plus the space after it

    // Truncate the query if the row would otherwise overflow the terminal width.
    const maxQueryWidth = Math.max(1, width - glyphAndSpaceWidth - badge.length - 1);
    const query =
      entry.query.length > maxQueryWidth
        ? entry.query.slice(0, Math.max(1, maxQueryWidth - 1)) + "..."
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
// 5. Tool registration
// =============================================================================

/**
 * Minimal local typings for the pi extension surface this tool touches. pi supplies the
 * `api` and `theme` objects at runtime and does not export their types, so we declare just
 * the members we use -- enough to keep the boundary type-safe without depending on internals.
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
  details: { progressByQuery: QueryProgress[]; dropped: number };
}

interface ToolResultPayload {
  content: { type: "text"; text: string }[];
  details: { progressByQuery: QueryProgress[]; dropped: number };
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
      "Search the web. Call this whenever current or external information would change your answer -- " +
      "latest versions, APIs, prices, dates, events, or anything you can't verify from " +
      "memory. Returns ranked result pages to follow up on.",
    promptSnippet: "web_search(searches: string[]): batch web search; returns ranked result pages",
    promptGuidelines: [
      "Use web_search to find sources -- pass a few focused queries to cover a topic from multiple angles.",
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

      // Cap the queries; anything past MAX_QUERIES is silently dropped (only the count surfaces, in the card).
      const searches = params.searches.slice(0, MAX_QUERIES);
      const dropped = params.searches.length - searches.length;

      // Start every query as "queued"; we update each one as it runs.
      const progressByQuery: QueryProgress[] = searches.map((query) => ({
        query: query,
        status: "queued",
        result: undefined,
      }));

      // Push the current progress to pi's UI so the card animates live.
      const reportProgress = () =>
        onUpdate?.({ content: [], details: { progressByQuery, dropped } });
      reportProgress();

      // Serial by construction; the per-fetch throttle handles rate limiting.
      for (let index = 0; index < searches.length; index++) {
        const query = searches[index];
        const entry = progressByQuery[index];
        if (query === undefined || entry === undefined) continue;

        entry.status = "loading";
        reportProgress();

        entry.result = await fetchReadablePage(buildSearchUrl(searchUrlTemplate, query));
        entry.status = entry.result.ok ? "done" : "error";
        reportProgress();
      }

      return {
        content: [
          {
            type: "text",
            text: formatResultsForModel(progressByQuery, maxCharsPerQuery, searchUrlTemplate),
          },
        ],
        details: { progressByQuery, dropped },
      };
    },

    // Width-aware (returns a `render(width)` component) so the [ status ] badge can right-align,
    // the same approach batch_web_fetch uses.
    renderResult(result, _opts, theme) {
      const { progressByQuery, dropped } = result.details;
      const text = new Text("", 0, 0);
      return {
        render(width) {
          text.setText(renderProgressCard(progressByQuery, dropped, theme, width));
          return text.render(width);
        },
        invalidate() {
          text.invalidate();
        },
      };
    },
  });
}
