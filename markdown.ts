// Turning fetched search results into the markdown the model reads. Everything here is a pure
// function over strings and plain data: no network, no disk, no pi API. index.ts fetches the
// pages and calls renderToolResult on what comes back.

/** One search result: the page title, and the URL with DuckDuckGo's redirect wrapper removed. */
export interface SearchResultLink {
  title: string;
  url: string;
}

/** The outcome of one fetch. `requestedUrl` and `finalUrl` differ when the request was redirected. */
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

export type QueryStatus = "queued" | "loading" | "done" | "error";

/**
 * One query: where it has got to, and what it found once done. The functions below only read
 * `result`; `status` is here because index.ts draws a progress row per query from the same list.
 */
export interface QueryProgress {
  query: string;
  status: QueryStatus;
  result: PageFetchResult | undefined;
}

// =============================================================================
// Tidying up one extracted page
// =============================================================================

// Number each result heading, so the snippets state DuckDuckGo's ranking instead of merely
// following it, and a result can be pointed at by number. Runs before demoteHeadings, while
// result titles are still the `##` Defuddle gives them. On a results page these are the only
// headings there are, because the page is nothing but results.
export function numberResultHeadings(markdown: string): string {
  let resultNumber = 0;
  return markdown.replace(/^## /gm, () => {
    resultNumber += 1;
    return `## ${resultNumber}. `;
  });
}

// Push every heading down one level, so result titles sit under the query heading added later.
// An `h6` stays where it is, because markdown has nothing below it.
export function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,5}) /gm, "#$1 ");
}

// A bare URL never contains a space, so a space is what separates a real label from one.
function labelReadsAsProse(label: string): boolean {
  return /\s/.test(label.trim());
}

// Turn every markdown link into plain text, keeping whichever half says something. DuckDuckGo
// repeats each URL three times: once as the title heading, once as the visible link text, and
// once wrapped around the snippet. Keeping the label when it is prose, and the address when the
// label is just the URL again, leaves each result reading as title, URL, snippet.
export function flattenMarkdownLinks(markdown: string): string {
  const markdownLink = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  return markdown.replace(markdownLink, (_whole, label: string, address: string) =>
    labelReadsAsProse(label) ? label : address,
  );
}

// Replace DuckDuckGo's redirect links with where they actually go. They look like
// `https://duckduckgo.com/l/?uddg=<escaped-url>&rut=...`, sometimes with the `https:` left off
// the front.
export function expandRedirectLinks(markdown: string): string {
  const redirectLink =
    /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;

  return markdown.replace(redirectLink, (_whole, escapedUrl: string) =>
    decodeURIComponent(escapedUrl),
  );
}

// Both link fixes in the order they have to run: resolve the redirects, then drop the markup.
export function cleanUpLinks(markdown: string): string {
  return flattenMarkdownLinks(expandRedirectLinks(markdown));
}

// =============================================================================
// Building the answer handed back to the model
//
// Two sections, built separately and joined:
//
//   # Search results by query      renderSearchResults
//   ## Query: "..."                  renderQuerySection, once per query
//   ### 1. <result title>              the tidied, numbered snippets
//
//   # Read these pages             renderLinkSummary
//   <instruction>                    FETCH_INSTRUCTION
//   ## <query>                       that query's links
//   1. [title](url)
//
// Both sections count DuckDuckGo's results in the same order, so result 1 above is link 1 below.
// Queries themselves are never numbered; only the results within one are ranked.
// =============================================================================

// The tools that open result links. Both come from pi-smart-fetch, which is required.
export const FETCH_TOOL_NAME = "web_fetch";
export const BATCH_FETCH_TOOL_NAME = "batch_web_fetch";

export const SEARCH_RESULTS_HEADER = "# Search results by query";
export const LINK_SUMMARY_HEADER = "# Read these pages";

// The sentence telling the model what to do with the links.
export const FETCH_INSTRUCTION =
  `Open the most relevant links below before answering -- ${FETCH_TOOL_NAME} for a single page, ` +
  `${BATCH_FETCH_TOOL_NAME} for two or three. Pick the few that best answer the question rather ` +
  "than the whole list. These previews are brief and may be out of date; skip fetching only if " +
  "they already fully answer the question.";

export function renderQuerySection(entry: QueryProgress): string {
  const heading = `## Query: "${entry.query}"`;
  const result = entry.result;

  if (!result?.ok) {
    return `${heading}\n_search failed: ${result?.error ?? "unknown"}_\n`;
  }

  const withPlainLinks = cleanUpLinks(result.readableText);
  const withNumberedResults = numberResultHeadings(withPlainLinks);
  const snippets = demoteHeadings(withNumberedResults);

  return `${heading}\n${snippets || "_no content extracted_"}\n`;
}

export function renderSearchResults(searches: QueryProgress[]): string {
  return [SEARCH_RESULTS_HEADER, ...searches.map(renderQuerySection)].join("\n");
}

// The second section: the instruction, then each query's links as a numbered list. Comes back
// empty when no query found anything, and the caller then leaves the section out.
export function renderLinkSummary(searches: QueryProgress[]): string {
  const blocks: string[] = [];

  for (const entry of searches) {
    if (!entry.result?.ok || entry.result.links.length === 0) continue;
    const links = entry.result.links.map(
      (link, index) => `${index + 1}. [${link.title}](${link.url})`,
    );
    blocks.push(`## ${entry.query}\n${links.join("\n")}`);
  }

  if (blocks.length === 0) return "";

  return [LINK_SUMMARY_HEADER, "", FETCH_INSTRUCTION, "", blocks.join("\n\n")].join("\n");
}

export function renderToolResult(searches: QueryProgress[]): string {
  const summary = renderLinkSummary(searches);
  const sections = [renderSearchResults(searches)];
  if (summary) sections.push(summary);
  return sections.join("\n");
}
