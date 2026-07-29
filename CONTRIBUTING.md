# Contributing

This file covers the tooling, not the code. The code is meant to explain itself; if a change needs a paragraph here to make sense, that is a sign the change wants a comment instead.

## The bar

A pull request passes when `.github/workflows/ci.yml` passes. That workflow is the whole bar, and every step in it can be run locally:

```sh
npm run check
```

That runs the same five things CI does, in the same order:

| step      | command                | what it is                                                                                                                                         |
| --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck | `npm run typecheck`    | `tsc --noEmit`. Nothing else reports a type error -- ESLint reports rule violations and vitest does not check types at all.                        |
| Prettier  | `npm run format:check` | Formatting. Prettier owns it entirely; do not hand-format.                                                                                         |
| ESLint    | `npm run lint`         | Type-aware rules from `typescript-eslint`. It also catches unnecessary casts and non-null assertions, which usually mean the types already worked. |
| cspell    | `npm run spell`        | Spelling, across every file including markdown. Add real words to `cspell.json`.                                                                   |
| Tests     | `npm run test`         | vitest. CI runs `npm run coverage`, which is the same suite plus the floors below.                                                                 |

Fixers, when something fails:

```sh
npm run lint:fix   # ESLint autofixes
npm run format     # Prettier writes
npm run test:watch # vitest in watch mode
```

## Coverage

`npm run coverage` enforces per-file floors set in `vitest.config.ts`. They are per file rather than aggregate so that neither file can hide a regression behind the other.

`markdown.ts` is pinned at 100% statements, functions and lines. It is pure functions over strings, so anything less is a gap rather than a constraint.

`index.ts` sits lower because `renderCall` is deliberately untested, matching how pi treats its own tools' renderers.

The floors sit slightly under what the suite reaches, on purpose. A floor set exactly at the current number turns the number into the goal, and the last few points get bought with tests that call a function to reach a line rather than to assert anything.

Raise a floor when real coverage rises. Do not lower one to make a change fit.

## Git hooks

Husky installs these on `npm install`:

- **pre-commit** runs `lint-staged`: ESLint `--fix` and Prettier over staged files only.
- **pre-push** runs `npm run coverage`, so a push cannot carry a failing suite or a coverage drop.

Neither hook typechecks -- that would make every commit slow. Run `npm run check` before opening a PR.

## Running your changes in pi

pi loads `index.ts` directly, with no build step:

```sh
npm install
pi install .
```

Start pi and the tool is registered. Source edits take effect the next time pi starts. `pi uninstall .` reverses it, and both are safe to run repeatedly.

To see what the model actually received, run a search and press the expand key (`ctrl+o` by default). That swaps the progress card for the exact markdown the tool returned.

## Tests

Test files mirror source files: `markdown.ts` is covered by `markdown.test.ts`, `index.ts` by `index.test.ts`. One source module means one test module.

Two mocks are file-scoped in `index.test.ts` and apply to everything in it: `wreq-js` so no request leaves the machine, and `getAgentDir` so the "global" settings path points somewhere that does not exist. Nothing in the suite touches the network or reads a real settings file.

`execute`, `renderResult` and the `session_start` handler are closures inside `registerTool`, so they are reached by running the extension's entry point against a stub `ExtensionAPI` that captures what gets registered. See `registerExtension` in `index.test.ts`.

Tests assert behavior, not decisions. A test that only fails when the code changes, rather than when it breaks, does not belong.

## Style

ASCII only, everywhere -- no em dashes, arrows, or curly quotes. Prettier owns prose wrapping in markdown; do not hand-wrap.

Comments carry what the code cannot: DuckDuckGo's markup, pi's API behavior, why a decision went the way it did. They should not restate a signature.

## Releasing

See [PUBLISH.md](PUBLISH.md). Short version: merge to `main`, then `./publish.sh minor` from a clean, up-to-date `main`. Never bump the version or create the tag by hand.
