# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bruskots/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bruskots/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built by an AI agent for make.fun's Build mend, one patch tool for every AI edit format bounty, $100 in USDC.

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one specification (`SPEC.md`
in the competition kit): a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
It finds the lines each edit names even when the model drifted their whitespace
or indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

Old lines are found at the first of three tiers at which they occur at least
once: exact equality, then equality after trailing whitespace is removed,
then equality after leading and trailing whitespace is removed. At tier 2,
added lines are re-indented from the patch's indentation to the file's, and
context lines are always written as the file's own matched lines.

## Exit codes

- `0`: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R old -> new` for a move), then `ok: <n> files`.
- `1`: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Nothing is written.
- `2`: exactly one line — `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Files

- `main.ts`: the CLI. Node 22, standard library only.
- `runner.ts`: the kit's trial harness. When `MAKEFUN_ENV_URL` is set, `main.ts`
  hands the trial over to it.
- `check.ts`: runs the public practice set against `main.ts`.

## Practice score

100 of 100 practice checks pass — practice score **1000** — verified locally
with the kit's practice set (`node check.ts ../program/generator/practice.json`).
