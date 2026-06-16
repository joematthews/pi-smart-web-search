/**
 * Debug helper: run one search through the real pipeline and print the markdown.
 *
 *   npx tsx debug.ts "your search query"
 *
 * Uses the same functions the extension uses (imported from index.ts), so what you
 * see here is exactly what the model would get — including the redirect-link cleanup.
 */

import {
  DEFAULT_SEARCH_URL_TEMPLATE,
  buildSearchUrl,
  fetchReadablePage,
  parseDuckDuckGoLinks,
} from "./index.ts";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: npx tsx debug.ts "your search query"');
  process.exit(1);
}

const url = buildSearchUrl(DEFAULT_SEARCH_URL_TEMPLATE, query);
console.error(`→ fetching: ${url}\n`);

const page = await fetchReadablePage(url);
if (!page.ok) {
  console.error(`✗ fetch failed: ${page.error}`);
  process.exit(1);
}

const markdown = parseDuckDuckGoLinks(page.readableText);

// Flag any DuckDuckGo redirect links that slipped through the cleanup.
const leftovers =
  markdown.match(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*\buddg=/gi) ??
  [];

console.log(markdown);
console.error(
  `\n${"─".repeat(60)}\n${markdown.length} chars · ${
    leftovers.length === 0
      ? "✓ no redirect links"
      : `✗ ${leftovers.length} redirect link(s) survived`
  }`,
);
process.exit(leftovers.length === 0 ? 0 : 1);
