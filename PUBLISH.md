# Publishing

How a new version of `pi-smart-web-search` reaches npm.

## TL;DR

Bump the version in a pull request. Merging it to `main` publishes.

```sh
npm version minor --no-git-tag-version
```

That edits `package.json` only. Commit it, open the PR, merge. There is no tag to create, no GitHub Release to cut, and no `npm publish` to run by hand.

## Choosing the bump

Following semver, and noting that at `0.x` a breaking change is a `minor`, not a `major` -- `major` would mean declaring 1.0.0:

- `patch` -- bug fixes, docs. `0.4.0 -> 0.4.1`
- `minor` -- new features, and breaking changes while at `0.x`. `0.4.0 -> 0.5.0`
- `major` -- reserved for 1.0.0 and beyond.

Always pass `--no-git-tag-version`. Without it `npm version` creates a local tag that the workflow will later try to create again.

## Batching, and who bumps

A merge that does not change the version publishes nothing, so ordinary pull requests can land freely and a release is cut when you want one. The Release notes are generated from every pull request merged since the previous release tag, not just the bump, so batching costs nothing in the changelog.

For anything with contributors, prefer that: nobody bumps the version in a feature PR, and a separate bump PR cuts the release. It keeps the decision to publish in one place.

Label your pull requests. `.github/release.yml` sorts the notes by label, and anything unlabelled lands under "Other changes" rather than being dropped.

## What happens on merge

`.github/workflows/publish.yml` fires on every push to `main` and asks npm whether the version in `package.json` already exists.

- **Already on npm** -- the run stops there. Nothing is published.
- **New version** -- `npm ci`, `npm run check`, `npm publish --access public`, then the commit is tagged `v<version>`, the tag is pushed, and a GitHub Release is created from it.

The Release is a _consequence_ of a successful publish, not the trigger for one. A failed step ends the job, so a tag and a Release can never describe a version npm does not actually have.

The workflow also runs `npm pkg delete scripts.prepare` immediately before publishing. `prepare` installs git hooks for anyone who clones this repo and does nothing for anyone who installs the package, but npm records it in the registry metadata and warns every consumer that the package "has install scripts". The deletion belongs in the workflow rather than in a `prepack` hook, because npm reads the manifest before the pack lifecycle runs.

Publishing uses npm **trusted publishing** (OIDC), so there is no `NPM_TOKEN` and provenance is attached automatically.

Watch it: `gh run watch`.

## What the pipeline relies on

- **The repository is public.** Under trusted publishing npm generates a provenance attestation automatically, and provenance is [not supported from private source repositories](https://docs.npmjs.com/generating-provenance-statements/).
- **A `release` environment whose deployment branch policy names `main`.** The trigger is a push to a branch, not a tag. A policy left scoped to `v*` tags blocks the deployment, and it fails by refusing to start rather than by reporting a useful error.
- **The trusted publisher on npm matches** the repository, the workflow filename `publish.yml`, and the environment name `release`. npm trusts the workflow that _triggers_ the run, so nothing may publish from a reusable workflow it calls.
- **Node 22.14 or later and npm 11.5.1 or later**, which trusted publishing requires. The workflow reads `.nvmrc` and runs `npm install -g npm@latest`.

## Do not

- Run `npm publish` yourself.
- Create the `v*` tag by hand -- the workflow does it, and a tag that disagrees with `package.json` is confusing at best.
- Bump the version in a commit straight to `main`, which bypasses the review the model depends on.
