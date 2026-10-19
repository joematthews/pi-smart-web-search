// You.com search source -- maps the You.com API response into the same PageFetchResult shape
// fetchReadablePage returns for a DuckDuckGo page, so the existing render pipeline (snippets
// plus the link summary) works unchanged. Pure functions only: the network call lives in
// index.ts, the same way this file's sibling markdown.ts keeps the pure string work and
// index.ts does the fetching.
//
// You.com has two response shapes and this module reads either one:
//   - keyed Agents API (POST): a flat `results` array, each item with `snippet` (string).
//   - keyless Agents API (GET) and the older Search API: `results: { web: [...] }`, each item
//     with `snippets` (array). normalizeYoucomResults returns one list either way, so the
// caller does not have to know which endpoint answered.

import type { PageFetchResult, SearchResultLink } from "./markdown.ts";

// One result from either You.com endpoint. Every field is optional because the two endpoints
// fill them differently and a result may carry only some of them.
export interface YoucomResult {
  title?: string;
  url?: string;
  description?: string;
  // `snippets` is an array on the keyless/Search API; `snippet` is a string on the keyed
  // Agents API. The mapper falls back to `description` when neither carries text.
  snippets?: string[];
  snippet?: string;
}

// Turn one You.com response into a flat list of results, whether `results` is an array
// (keyed Agents API) or an object with a `web` array (keyless Agents API, older Search API).
// A response that is not the expected shape returns an empty list, which the builder turns
// into an error result rather than a silent zero-match.
export function normalizeYoucomResults(data: unknown): YoucomResult[] {
  if (typeof data !== "object" || data === null) return [];
  if (!("results" in data)) return [];
  const results: unknown = data.results;
  if (Array.isArray(results)) return results as YoucomResult[];
  if (typeof results === "object" && results !== null && "web" in results) {
    const web: unknown = results.web;
    if (Array.isArray(web)) return web as YoucomResult[];
  }
  return [];
}

// The readable markdown for one result: a level-2 heading with the title, the URL, then the
// snippet text. renderQuerySection demotes the heading and numbers it, the same way it tidies
// a DuckDuckGo page, so the two sources read the same in the answer. The `?? ""` collapses
// `undefined` to a string so the `||` after it is an empty-string fallback (the same shape
// markdown.ts uses for `snippets || "..."`), not a nullish one.
function resultToMarkdown(result: YoucomResult): string {
  const title = (result.title?.trim() ?? "") || "(untitled)";
  const url = result.url ?? "";
  const snippetText = (Array.isArray(result.snippets) ? result.snippets[0] : result.snippet) ?? "";
  const snippet = snippetText || (result.description ?? "");
  return [`## ${title}`, url, snippet].filter(Boolean).join("\n");
}

// Build the PageFetchResult the tool already renders. `links` carries the ranked result links
// for the "Read these pages" summary; `readableText` carries the per-result snippets for the
// "Search results by query" section. Results with no usable URL are dropped before either list
// is built, because a result link that cannot be opened is not a result the model can follow.
export function buildYoucomPageResult(
  results: YoucomResult[],
  count: number,
  requestedUrl: string,
): PageFetchResult {
  const valid = results
    .filter(
      (r): r is YoucomResult & { url: string } => typeof r.url === "string" && r.url.length > 0,
    )
    .slice(0, count);

  if (valid.length === 0) {
    return {
      ok: false,
      requestedUrl,
      error: "You.com returned no results with a usable URL",
    };
  }

  const links: SearchResultLink[] = valid.map((r) => ({
    title: (r.title?.trim() ?? "") || "(untitled)",
    url: r.url,
  }));

  const readableText = valid.map(resultToMarkdown).join("\n\n").trim();

  return {
    ok: true,
    requestedUrl,
    finalUrl: requestedUrl,
    title: "You.com search results",
    readableText,
    links,
  };
}
