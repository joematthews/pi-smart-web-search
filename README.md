# pi-smart-web-search

A [pi](https://pi.dev) extension that adds one tool -- **`web_search`** -- for batch web discovery.

![web_search in pi -- search, fetch, answer](https://raw.githubusercontent.com/joematthews/pi-smart-web-search/main/demo.png)

It takes an **array of queries**, turns each into a search URL,
and runs it through the same fetch->extract pipeline as [pi-smart-fetch](https://pi.dev/packages/pi-smart-fetch) (`wreq-js` -> `linkedom` ->
`Defuddle`). It returns each query's extracted results (titles, links, snippets as markdown),
followed by a `# Fetch the most relevant links` menu -- the top links per query -- for the model to open.

So the model **curates** which links to open (no SEO-trash auto-pulled into context), and the
follow-up nudge sits right below the links.

## Install

```sh
pi install npm:pi-smart-web-search
pi install npm:pi-smart-fetch   # strongly recommended companion (see below)
```

Then restart pi.

### Pairs with pi-smart-fetch

`web_search` finds and ranks sources; **[`pi-smart-fetch`](https://pi.dev/packages/pi-smart-fetch)**'s
`batch_web_fetch` is the intended way to read the chosen pages, so installing it alongside is
**strongly recommended**. It isn't required -- without it the model falls back to whatever fetch
capability it has (e.g. `curl` through a shell tool); `web_search` still works, the follow-up is just
less clean.

## Usage

Once installed, start up pi and just ask a question -- `web_search` kicks in automatically when an
answer needs current or external info. Try:

```
What's the latest version of Node.js, and what's new in it?
```

```
Compare Bun and Deno for a new TypeScript API in 2026.
```

pi searches, opens the best results, and answers from what it read. No flags, no setup -- just ask.

## Tool

```
web_search(searches: string[])
```

Pass a few focused queries at once to cover a topic from multiple angles in one call.

## Development

Run from a local clone instead of the registry:

```sh
git clone https://github.com/joematthews/pi-smart-web-search
cd pi-smart-web-search
npm install
pi install .
```

Then restart pi.

`npm run check` runs typecheck, lint, format, spell, and tests.
`npx tsx debug.ts "your query"` prints what the model would receive for a search.

## Credits

Heavily inspired by [pi-smart-fetch](https://pi.dev/packages/pi-smart-fetch) by
[Thinkscape](https://github.com/Thinkscape) (MIT). It shares the same pipeline (`wreq-js` -> `linkedom` -> `Defuddle`), and the `web_search` result card mirrors `batch_web_fetch`'s look. Thanks to that project for the pattern.

## License

[MIT](LICENSE) (c) Joe Matthews
