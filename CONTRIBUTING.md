# Contributing to `agentq-cli`

## Local development

```bash
git clone git@github.com:HorizonMedia/agentq-cli.git
cd agentq-cli
npm install
npm run build      # compile TypeScript → dist/
node bin/agentq.js --help

# Or symlink for active development:
npm link
agentq --help      # uses the linked source
```

## Layout

```
agentq-cli/
├── bin/agentq.js              # tiny shim → dist/cli.js
├── src/                       # TypeScript source
│   ├── cli.ts                 # yargs entry point
│   ├── commands/              # one file per command (open/closed)
│   ├── lib/                   # logger, paths, config, scaffolder, gcp, python, …
│   └── providers/             # KB providers (gemini-enterprise-search…)
├── python/agentq_runtime/     # bundled Python runtime (deploy, kb, state, …)
├── templates/
│   ├── common/                # shared skeleton (always rendered)
│   ├── patterns/              # one folder per orchestration pattern
│   ├── features/              # opt-in features (gitops, file-tools)
│   └── kb/                    # one folder per KB provider
├── scripts/
│   └── release.sh             # canonical release path (see below)
├── docs/
│   ├── GETTING_STARTED.md
│   └── DESIGN.md
└── tsconfig.json
```

## Release process

Use `scripts/release.sh` — it encodes every rule below and refuses to do the
wrong thing.

```bash
# Dry-run first; shows the exact git/npm commands without touching anything
# durable (it will bump package.json + run build, then revert package.json).
./scripts/release.sh v0.2.0 --dry-run

# When it looks right, do it.
./scripts/release.sh v0.2.0
```

The script:
1. Refuses if the working tree is dirty.
2. Refuses if the version tag already exists (locally or on origin).
3. Refuses if a bare `vMAJOR` **tag** exists on origin (that's the footgun
   that bit `agentq-actions` during the HorizonMedia migration — `vMAJOR`
   must be a branch, never a tag).
4. Bumps `package.json` to `X.Y.Z` (without auto-tagging).
5. Runs `npm run lint` + `npm run build` as a pre-release gate. If either
   fails, reverts the `package.json` bump and aborts.
6. Commits the bump as `Release vX.Y.Z`.
7. Creates `vX.Y.Z` as an annotated tag at HEAD.
8. Force-moves the floating `vMAJOR` **branch** to point at the new tag.
9. Pushes `main`, the tag, and the branch with explicit refspecs.
10. Prints a verification block + reminders (CHANGELOG, GitHub Release).

Before running it:

- Update `CHANGELOG.md` with a new version block.
- If you bumped any cross-repo contract (e.g. `plan.schema.json`), also
  open a PR in `agentq-actions` to mirror it under `tests/golden/`.

## How consumers install

```bash
# Floating major (latest v1.x.y)
npm install -g github:HorizonMedia/agentq-cli#v1

# Pinned exact version
npm install -g github:HorizonMedia/agentq-cli#v0.2.0

# Override the source repo for forks / mirrors
export AGENTQ_CLI_REPO=github:my-fork/agentq-cli#v1
npm install -g "$AGENTQ_CLI_REPO"
```

The `prepare` hook in `package.json` runs `npm run build` during install so
consumers always get a freshly compiled CLI for the ref they pinned.

## Cross-repo contract: `plan.schema.json`

`python/agentq_runtime/schemas/plan.schema.json` is the canonical version of
the plan-artifact schema. `agentq-actions` vendors a byte-identical copy
under `tests/golden/`. If you change this file:

1. Update the corresponding example: `plan.example.json`.
2. Open a 1-line PR in `agentq-actions` mirroring the new schema.
3. If the change is **breaking** (renamed/removed fields), bump
   `schema_version` and coordinate major-version bumps in both repos.

CI in `agentq-actions` diffs the two and fails the build if they diverge.
