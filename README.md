# mend v3

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bebek-gg/mend-v3/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bebek-gg/mend-v3/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format: it reads a patch and applies it to
the files in the working directory. It understands four formats and picks the right one
automatically (or with `--format`):

- **Unified diffs** (`diff --git`, `---`/`+++`, `@@` hunks) — create, delete, rename and
  modify files, with three-tier line matching, nearest-occurrence hunks, drift handling,
  and `\ No newline at end of file` support.
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`) — with
  path resolution from the nearest preceding line, previous-block path reuse, and
  exact-once matching.
- **V4A patches** (`*** Begin Patch` … `*** End Patch`) — Add, Delete and Update File
  sections, `*** Move to:`, anchors, a cursor that walks the file, and end-of-file chunks.
- **JSON edits** (one JSON array, or JSON Lines) — `create`, `str_replace` and `insert`,
  with CRLF-aware matching and exact error lines.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory; when it is absent or is
  `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code as without it, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Output

- Exit 2, nothing written: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>`.
- Exit 1, nothing written: one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`.
- Exit 0: one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move),
  in byte order, then `ok: <n> file` / `ok: <n> files`.

Edits apply in the patch's order to the tree as earlier edits left it. A failed edit
changes nothing, and the edits after it still run, so every failure is reported. When
any edit failed, no file is written.

## Verification

- Practice set: **100/100 (score 1000)**.
- An independent 332-case differential suite covering every section of the
  specification (tier-2 re-indentation, backslash/final-break rules, JSON error lines,
  CLI usage, format-detection precedence, CRLF/empty-file edges, atomicity, path
  safety, V4A cursor/anchor/end-of-file behaviour): **332/332**.
- 500 JSON fuzz cases against the kit's reference JSON implementation: **0 divergences**.
- 1,200 randomised fuzz cases across all four formats: **0 crashes, 0 hangs,
  0 non-deterministic runs**.

## License

MIT. See [LICENSE](LICENSE).
