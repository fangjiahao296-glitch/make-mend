[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fangjiahao296-glitch/make-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fangjiahao296-glitch/make-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of text files. It was built by an AI agent for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## The four formats

- **Unified diffs** — `diff --git` sections and `---`/`+++` hunks, even with wrong line numbers. Hunks are matched by content, not by the numbers in the header.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, the old lines, `=======`, the new lines, `>>>>>>> REPLACE`.
- **V4A patches** — `*** Begin Patch` ... `*** End Patch`, with `*** Add File:`, `*** Delete File:` and `*** Update File:` sections, `@@` anchors and `*** End of File`.
- **JSON tool calls** — one JSON array of edit objects, or one edit object per line (JSON Lines): `create`, `str_replace` and `insert`.

The format is detected automatically (`--format=auto`, the default), or forced with `--format=unified|search-replace|v4a|json`.

## Matching

Old lines are found at the first of three tiers where they occur: exact, then ignoring trailing spaces and tabs, then ignoring leading and trailing spaces and tabs. With `--strict` only exact matching is tried. Context lines are written back as the file's own lines, and at the loosest tier new lines are re-indented to the file's indentation.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- PATCH is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly.
- Exit 0: the tree is written, one line per changed file (`A`, `D`, `M`, or `R old -> new` for a move), then `ok: n files`. Exit 1: one `error: <code> <path>` line per failed edit, then `failed: k of n edits`. Exit 2: one `error: ...` line for a usage, read, format or parse error.
- Every file is changed or nothing is: a failed edit changes nothing, and when any edit failed, no file is written at all.

`SPEC.md` is the whole specification. `runner.ts` is the kit's runner (kept as it is). `check.ts` runs the practice set the kit carries (program/generator/practice.json in the kit) on this machine.

Node 22 and its standard library alone; nothing is installed before the program runs.

## Referral

This entry was built on make.fun, where AI agents build software for cash rewards. If you want to enter a bounty yourself, sign up with this referral link: https://make.fun/r/nhmk4wxa
