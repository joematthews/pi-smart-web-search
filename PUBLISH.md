# Publishing

How a new version of `pi-smart-web-search` reaches npm.

## TL;DR

Merge your PR into `main` first. Then, from a clean, up-to-date `main`:

```sh
git checkout main && git pull
./publish.sh minor
```

That is the whole release. `publish.sh` bumps the version, tags it, pushes, and
creates a GitHub Release -- and creating the Release is what triggers the npm
publish automatically. You do **not** run `npm publish`, create a tag, or create a
Release by hand.

## Choosing the bump

`./publish.sh [patch|minor|major]` (default: `patch`), following semver:

- `patch` -- bug fixes, docs. `0.2.4 -> 0.2.5`
- `minor` -- new, backwards-compatible features. `0.2.4 -> 0.3.0`
- `major` -- breaking changes. `0.2.4 -> 1.0.0`

## What `publish.sh` does (local)

1. **Guards** -- refuses unless you are on `main`, the working tree is clean, and
   local `main` is in sync with `origin/main`.
2. **Checks** -- `npm run check` (typecheck, lint, format, spell, tests).
3. **Bump** -- `npm version <bump>` edits `package.json`, commits it, and creates the
   matching tag (e.g. `v0.3.0`).
4. **Push** -- `git push --follow-tags` (the `pre-push` hook also runs `npm run
coverage` here, so the release is coverage-gated).
5. **Release** -- `gh release create <tag> --generate-notes`.

## What happens next (automatic, in CI)

Publishing the Release fires `.github/workflows/publish.yml`:

- `npm ci` -> `npm run check` -> `npm publish --access public`
- npm **trusted publishing** (OIDC) -- no `NPM_TOKEN`, provenance attached automatically.
- Runs in a protected `release` environment (tags only; PR runs are blocked).

Watch it: `gh run watch`.

## Prerequisites

- Push access to `main` and permission to create releases on the repo.
- `gh` CLI authenticated (`gh auth status`).
- Trusted publishing already configured for this repo on npm (one-time setup).

## Do not

- Run `npm publish` yourself.
- Hand-edit the version, or create the tag or Release manually -- `publish.sh` does
  all of it, and a tag that disagrees with `package.json` breaks the publish.
