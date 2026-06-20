# pi-smart-web-search

A [pi](https://pi.dev) extension that adds one tool — **`web_search`** — for batch web discovery.

It takes an **array of queries** (batch-only, like `batch_web_fetch`), turns each into a search URL,
and runs it through the same fetch→extract pipeline as pi-smart-fetch (`wreq-js` → `linkedom` →
`Defuddle`). It returns the extracted search-results pages (titles, links, snippets as markdown),
prefaced with a `# Next step` header telling the model to open the best result URLs.

So the model **curates** which links to open (no SEO-trash auto-pulled into context), and the
follow-up nudge sits right next to the links.

## Install

```sh
pi install npm:pi-smart-web-search
pi install npm:pi-smart-fetch   # companion (see below)
```

Then restart pi.

### Pairs with pi-smart-fetch

`web_search` finds sources; it hands off to **`batch_web_fetch`** (from
[`pi-smart-fetch`](https://www.npmjs.com/package/pi-smart-fetch)) to read the chosen pages. Install
it alongside, or the model has nothing to follow up with.

## Usage

Once installed, start up pi and just ask a question — `web_search` kicks in automatically when an
answer needs current or external info. Try:

```
What's the latest version of Node.js, and what's new in it?
```

```
Compare Bun and Deno for a new TypeScript API in 2026.
```

pi searches, opens the best results, and answers from what it read. No flags, no setup — just ask.

## Tool

```
web_search(searches: string[])
```

Pass several queries at once to cover a topic from multiple angles in one call.

## Settings

Nested under a `smartWebSearch` object in `~/.pi/agent/settings.json` (or a project's
`.pi/settings.json`, which overrides):

| key         | default                                       | meaning                                                                                                                                                                                       |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `searchUrl` | `https://html.duckduckgo.com/html/?q={query}` | Search URL template. Must contain `{query}` (URL-encoded substitution). Swap to another engine here. Engine also selects the result-link parser — see [Result links](#result-links).          |
| `maxChars`  | `10000`                                       | Safety cap on extracted result text **per query**. A DDG page profiles at ~6.4k–7.9k chars; 10000 is the max + ~25% — won't truncate DDG, catches a runaway engine when you swap `searchUrl`. |

```jsonc
// ~/.pi/agent/settings.json
{
  "smartWebSearch": {
    "searchUrl": "https://html.duckduckgo.com/html/?q={query}",
    "maxChars": 10000,
  },
}
```

## Result links

Search engines rarely link straight to results — DDG wraps every link in a tracking redirect
(`//duckduckgo.com/l/?uddg=<real-url>&rut=…`), with the real destination percent-encoded inside. Left
raw, the model can't tell where a link goes without fetching it, so it tends to skip the results and
answer from snippets alone.

So after extraction, the markdown runs through a **per-engine link parser** that rewrites those
wrapped links back to their real URLs. The parser is **chosen by the `searchUrl`**:

- `searchUrl` contains `duckduckgo.com` → the DDG parser unwraps `uddg=` redirects.
- **Any other engine → no parser runs; links are shown raw.** The regex is too engine-specific to
  share, so each engine needs its own parser. Add one in `index.ts` (`parseXLinks` + a branch in
  `cleanSearchResultLinks`) if you swap `searchUrl` to a non-DDG engine and want clean links.

Inspect what a query actually returns — markdown to stdout, a link-cleanliness check to stderr:

```sh
npx tsx debug.ts "your search query"
```

## Notes

- **Search engine must be no-JS / server-rendered** to extract well. The DDG HTML endpoint
  works because it renders without JavaScript; `google.com` and other JS-heavy SERPs will extract
  poorly (the pipeline does not run JavaScript).
- Built on the same primitives as pi-smart-fetch (`wreq-js` browser-grade TLS, `Defuddle`
  extraction); it does not import pi-smart-fetch's code (factory-only export), only the shared libs.

## Development

Run from a local clone instead of the registry:

```sh
git clone https://github.com/joematthews/pi-smart-web-search
cd pi-smart-web-search
npm install
```

Point pi at the clone in `~/.pi/agent/settings.json`:

```jsonc
"packages": ["/absolute/path/to/pi-smart-web-search", "npm:pi-smart-fetch"]
```

`npm run check` runs typecheck, lint, format, spell, and tests.

## Credits

Heavily inspired by [pi-smart-fetch](https://www.npmjs.com/package/pi-smart-fetch) by
[Thinkscape](https://github.com/Thinkscape) (MIT). `web_search` is an independent implementation —
no code is copied — but it follows pi-smart-fetch's approach, shares its underlying pipeline
(`wreq-js` → `linkedom` → `Defuddle`), and its result card mirrors `batch_web_fetch`'s look. Thanks
to that project for the pattern.

## License

[MIT](LICENSE) © Joe Matthews
