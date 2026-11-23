// mend v3 — one patch tool for every AI edit format (SPEC.md, hidden-spec-cli-01).
// Implements the full specification: invocation, output and exit codes, safe paths,
// the file/line model, format detection, three-tier line matching, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and all-or-nothing application.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

// A patch that cannot be read in its format: exit 2 with one `error: parse <N>` line.
class ParseFailure extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

// One edit that failed: exit 1 with `error: <code> <path>` plus a `failed:` summary.
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and the empty
 *  piece after a final `\n` dropped. Line numbers count these lines from 1. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none
 *  of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Leading spaces and tabs of a line. */
function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line with trailing spaces and tabs removed. */
function rtrim(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** A line with leading and trailing spaces and tabs removed. */
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A file as lines plus its line break and whether it ends with one (SPEC section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  endsBreak: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', endsBreak: false };
  const nl = text.indexOf('\n');
  if (nl < 0) return { lines: [text], br: '\n', endsBreak: false };
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsBreak = text.endsWith(br);
  const lines = text.split(br);
  if (endsBreak) lines.pop();
  return { lines, br, endsBreak };
}

function renderDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.endsBreak ? doc.br : '');
}

/** Whether line `a` matches line `b` at a tier (SPEC section 5). */
function lineMatchesAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrim(a) === rtrim(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position at or after `from` where `needle` occurs in `hay` at `tier`.
 *  Occurrences may overlap. */
function occurrencesAt(needle: string[], hay: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = from; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) {
      if (!lineMatchesAt(needle[k]!, hay[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which `needle` occurs in `hay` at or after `from`,
 *  or -1 when it occurs at no tier. With `strict` only tier 0 is tried. */
function firstTierWith(needle: string[], hay: string[], from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    if (occurrencesAt(needle, hay, t, from).length > 0) return t;
  }
  return -1;
}

/** A chunk/hunk: O is its context and `-` lines, N its context and `+` lines (both in body
 *  order). `ctx` maps an index in N that is a context line to the index of the same line
 *  in O. */
interface Chunk {
  O: string[];
  N: string[];
  ctx: Map<number, number>;
}

/** The lines that replace the matched lines when a chunk applies at position `at` in the
 *  file at `tier`: context lines are the file's own matched lines, and at tier 2 every
 *  other line of N is re-indented (P, the leading whitespace of O's first line, replaced
 *  by F, that of the file's first matched line) when it is neither empty nor only
 *  whitespace and starts with P. At tiers 0 and 1 the lines of N are written as they are. */
function renderNew(chunk: Chunk, fileLines: string[], at: number, tier: number): string[] {
  const F = leadOf(fileLines[at] ?? '');
  const P = leadOf(chunk.O[0] ?? '');
  const out: string[] = [];
  for (let j = 0; j < chunk.N.length; j++) {
    const oi = chunk.ctx.get(j);
    if (oi !== undefined) {
      out.push(fileLines[at + oi]!);
    } else if (tier === 2) {
      const line = chunk.N[j]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(P)) {
        out.push(F + line.slice(P.length));
      } else {
        out.push(line);
      }
    } else {
      out.push(chunk.N[j]!);
    }
  }
  return out;
}

/** The tree as the edits leave it. `now` holds every path an edit touched (null: deleted);
 *  anything else is read from disk on first use. */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  /** The content a path had before the patch (null: it did not exist). */
  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  /** The content a path has now (null: deleted or never existed). */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  /** A shallow copy of the touched state, for rolling one edit back. */
  snapshot(): Map<string, string | null> {
    return new Map(this.now);
  }

  restore(snap: Map<string, string | null>): void {
    this.now.clear();
    for (const [k, v] of snap) this.now.set(k, v);
  }
}

/** One edit of a patch: apply it to the tree (throwing EditFailure when it fails), and,
 *  for a move edit, the old and new path so the output can print an `R` line. */
interface Edit {
  apply(tree: WorkTree): void;
  move: { from: string; to: string } | null;
}

function editOf(fn: (tree: WorkTree) => void, move: { from: string; to: string } | null = null): Edit {
  return { apply: fn, move };
}

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patchFile: string | null;
}

/** Parse the command line (SPEC section 1). Returns null on a usage error. */
function parseArgs(args: string[]): Options | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !(FORMATS as readonly string[]).includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  return {
    format: format ?? 'auto',
    check,
    strict,
    patchFile: pos.length === 0 || pos[0] === '-' ? null : pos[0]!,
  };
}

/** Detect the patch format (SPEC section 4), or null when none is detected. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** Compare two paths in UTF-8 byte order. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** One JSON edit object (SPEC section 9), or null when it is not one. The returned edit
 *  checks the path's safety before anything else about it (SPEC section 10). */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  const needExisting = (tree: WorkTree): string => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return editOf((tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, text);
    });
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return editOf((tree) => {
      const before = needExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      // CRLF: file text and both strings are read with every `\r\n` as `\n`, and the
      // result is written back with `\r\n`. For an LF file nothing is normalised.
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    });
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return editOf((tree) => {
      const before = needExisting(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new EditFailure('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, renderDoc({ lines, br: doc.br, endsBreak: doc.endsBreak }));
    });
  }
  return null;
}

/** Read a JSON patch (SPEC section 9). Array form: any fault is `error: parse <the line
 *  where the array starts>`. JSON Lines: a line that does not hold one valid edit object
 *  is `error: parse <that line>`. */
function readJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFailure(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFailure(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFailure(first + 1);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseFailure(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFailure(i + 1);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: A is the `-A` number from its header (the 1-based line the hunk starts
 *  at in the old file, 0 when it inserts at the top). */
interface UHunk {
  A: number;
  chunk: Chunk;
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  bsAfterLast: boolean;
  /** Whether a `\` line follows the hunk's last `+` line (false when it has none). */
  bsAfterLastPlus: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

/** The path from a `--- ` or `+++ ` header line: the text after the four characters, up to
 *  the first tab, with surrounding spaces removed. A leading `a/` or `b/` is removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse a `diff --git a/<X> b/<Y>` line into [X, Y], or null when it is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Read a unified patch (SPEC section 6) into one edit per section. */
function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;

  const finishSection = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const startSection = (): USection => {
    finishSection();
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    inHeader = true;
    return cur;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = diffGitPaths(line);
      if (paths === null) throw new ParseFailure(i + 1);
      const s = startSection();
      s.oldPath = paths[0];
      s.newPath = paths[1];
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        // A new section (not part of a section's header).
        const s = startSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      // Part of the current section's header: a `---`/`+++` pair before the first
      // hunk names the old and new path (a later pair overwrites an earlier one).
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      // A `--- ` line inside a section's header, not followed by `+++ `.
      throw new ParseFailure(i + 2);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFailure(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseFailure(i + 1);
      inHeader = false;
      const A = parseInt(m[1]!, 10);
      // The hunk's body: lines starting with ` `, `-`, `+` or `\`, or empty lines.
      // It ends at the first other line, at a `diff --git ` line, at a `--- ` line
      // followed by a `+++ ` line, or at the end of the patch. Empty lines at the
      // end of a body are not part of it.
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (
          bl.startsWith('diff --git ') ||
          (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))
        ) {
          break;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j += 1;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      // Build O, N and the context map, and note where `\` lines fall.
      const O: string[] = [];
      const N: string[] = [];
      const ctx = new Map<number, number>();
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('\\')) {
          continue;
        }
        if (bl.startsWith(' ') || bl === '') {
          const text = bl === '' ? '' : bl.slice(1);
          ctx.set(N.length, O.length);
          O.push(text);
          N.push(text);
        } else if (bl.startsWith('-')) {
          O.push(bl.slice(1));
        } else if (bl.startsWith('+')) {
          N.push(bl.slice(1));
        }
      }
      // Whether a `\` line follows the hunk's last context or `+` line, and whether one
      // follows its last `+` line. A `\` line refers to the body line before it.
      const followedByBs = (k: number): boolean => body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
      let bsAfterLast = false;
      let bsAfterLastPlus = false;
      let foundLast = false;
      let foundLastPlus = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const bl = body[k]!;
        if (bl.startsWith('\\')) continue;
        if (!foundLast && (bl.startsWith(' ') || bl === '' || bl.startsWith('+'))) {
          bsAfterLast = followedByBs(k);
          foundLast = true;
        }
        if (!foundLastPlus && bl.startsWith('+')) {
          bsAfterLastPlus = followedByBs(k);
          foundLastPlus = true;
        }
        if (foundLast && foundLastPlus) break;
      }
      cur.hunks.push({ A, chunk: { O, N, ctx }, bsAfterLast, bsAfterLastPlus });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.newPath = line.slice('rename to '.length).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  finishSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified section as an edit (SPEC section 6). */
function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const isCreate = oldP === '/dev/null' || s.isCreate;
  const isDelete = newP === '/dev/null' || s.isDelete;
  if (isCreate) {
    const target = newP!;
    return editOf((tree) => {
      if (!isSafePath(target)) throw new EditFailure('unsafe', target);
      if (tree.get(target) !== null) throw new EditFailure('exists', target);
      // The file is the `+` lines of all its hunks, in order. It ends with a line break
      // unless a `\` line follows its last `+` line.
      const created: string[] = [];
      let lastPlusBs = false;
      for (const h of s.hunks) {
        const chunk = h.chunk;
        for (let j = 0; j < chunk.N.length; j++) {
          if (!chunk.ctx.has(j)) created.push(chunk.N[j]!);
        }
        if (chunk.N.some((_, j) => !chunk.ctx.has(j))) {
          lastPlusBs = h.bsAfterLastPlus;
        }
      }
      tree.set(
        target,
        renderDoc({ lines: created, br: '\n', endsBreak: created.length === 0 ? false : !lastPlusBs }),
      );
    });
  }
  if (isDelete) {
    const target = oldP!;
    return editOf((tree) => {
      if (!isSafePath(target)) throw new EditFailure('unsafe', target);
      if (tree.get(target) === null) throw new EditFailure('missing', target);
      tree.set(target, null);
    });
  }
  const from = oldP!;
  const to = newP!;
  const isMove = from !== to;
  return editOf((tree) => {
    if (!isSafePath(from)) throw new EditFailure('unsafe', from);
    if (isMove && !isSafePath(to)) throw new EditFailure('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new EditFailure('missing', from);
    if (isMove && tree.get(to) !== null) throw new EditFailure('exists', to);
    const result = applyHunks(s.hunks, before, strict, from);
    tree.set(to, result);
    if (isMove) tree.set(from, null);
  }, isMove ? { from, to } : null);
}

/** Apply a section's hunks in order to a file's text (SPEC section 6). `strict` disables
 *  tiers 1 and 2. Returns the resulting text. */
function applyHunks(hunks: UHunk[], before: string, strict: boolean, path: string): string {
  let doc = parseDoc(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = h.chunk;
    if (O.length === 0) {
      const at = Math.min(h.A + d, doc.lines.length);
      const rendered = renderNew(h.chunk, doc.lines, at, 0);
      const lines = [...doc.lines];
      lines.splice(at, 0, ...rendered);
      const atEnd = at >= doc.lines.length;
      doc = {
        lines,
        br: doc.br,
        endsBreak: atEnd ? !h.bsAfterLast : doc.endsBreak,
      };
      d += N.length - O.length;
      continue;
    }
    const tier = firstTierWith(O, doc.lines, 0, strict);
    if (tier < 0) throw new EditFailure('no-match', path);
    const occ = occurrencesAt(O, doc.lines, tier, 0);
    const target = h.A - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const at = best;
    const rendered = renderNew(h.chunk, doc.lines, at, tier);
    const lines = [...doc.lines];
    lines.splice(at, O.length, ...rendered);
    const runsToEnd = at + O.length === doc.lines.length;
    doc = {
      lines,
      br: doc.br,
      endsBreak: runsToEnd ? !h.bsAfterLast : doc.endsBreak,
    };
    d += N.length - O.length;
  }
  return renderDoc(doc);
}

/** One SEARCH/REPLACE block as an edit (SPEC section 7). The old lines must occur at their
 *  tier exactly once, or the block fails with `ambiguous`; a created file (old lines empty)
 *  ends with a line break. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return editOf((tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.set(path, renderDoc({ lines: [...newLines], br: '\n', endsBreak: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    const doc = parseDoc(before);
    const tier = firstTierWith(oldLines, doc.lines, 0, strict);
    if (tier < 0) throw new EditFailure('no-match', path);
    const occ = occurrencesAt(oldLines, doc.lines, tier, 0);
    if (occ.length > 1) throw new EditFailure('ambiguous', path);
    const at = occ[0]!;
    const chunk: Chunk = { O: oldLines, N: newLines, ctx: new Map() };
    const rendered = renderNew(chunk, doc.lines, at, tier);
    const lines = [...doc.lines];
    lines.splice(at, oldLines.length, ...rendered);
    tree.set(path, renderDoc({ lines, br: doc.br, endsBreak: doc.endsBreak }));
  });
}

/** Read SEARCH/REPLACE blocks (SPEC section 7). */
function readSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const si = i;
    // The path is the nearest line before the SEARCH line, and after the previous
    // block's `>>>>>>> REPLACE` line (or the start of the patch), that is not blank
    // and, its surrounding whitespace removed, does not start with three backticks.
    let path: string | null = null;
    for (let k = si - 1; k > prevReplace; k--) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFailure(si + 1);
      path = prevPath;
    }
    // The `=======` and then the `>>>>>>> REPLACE` after the SEARCH line.
    let eq = -1;
    let rep = -1;
    for (let k = si + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '=======') {
        eq = k;
        break;
      }
    }
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        const t = lines[k]!.trimEnd();
        if (t === '<<<<<<< SEARCH') break;
        if (t === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new ParseFailure(si + 1);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk: an anchor (null: none), O/N with a context map, and whether `*** End of
 *  File` anchored it to the end of the file. */
interface VChunk {
  anchor: string | null;
  chunk: Chunk;
  eof: boolean;
}

function isV4ABodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

function addV4ABodyLine(c: VChunk, l: string): void {
  if (l.startsWith(' ') || l === '') {
    const text = l === '' ? '' : l.slice(1);
    c.chunk.ctx.set(c.chunk.N.length, c.chunk.O.length);
    c.chunk.O.push(text);
    c.chunk.N.push(text);
  } else if (l.startsWith('-')) {
    c.chunk.O.push(l.slice(1));
  } else if (l.startsWith('+')) {
    c.chunk.N.push(l.slice(1));
  }
}

/** Read a V4A patch (SPEC section 8). */
function readV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFailure(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFailure(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFailure(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    // Blank lines between sections are ignored.
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (head.startsWith('*** Add File: ')) {
      kind = 'add';
      path = head.slice('*** Add File: '.length).trim();
    } else if (head.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = head.slice('*** Delete File: '.length).trim();
    } else if (head.startsWith('*** Update File: ')) {
      kind = 'update';
      path = head.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseFailure(i + 1);
    }
    const headLine = i + 1;
    // The section's lines run to the next section header or `*** End Patch`.
    let end = i + 1;
    while (end < last) {
      const l = lines[end]!;
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      end += 1;
    }
    // Blank lines at the end of a section are not part of it.
    let bodyEnd = end;
    while (bodyEnd > i + 1 && isBlank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    const body = lines.slice(i + 1, bodyEnd);

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const l = body[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new ParseFailure(i + 2 + k);
      }
      edits.push(
        editOf((tree) => {
          if (!isSafePath(path)) throw new EditFailure('unsafe', path);
          if (tree.get(path) !== null) throw new EditFailure('exists', path);
          tree.set(path, renderDoc({ lines: fileLines, br: '\n', endsBreak: true }));
        }),
      );
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k++) {
        if (!isBlank(body[k]!)) throw new ParseFailure(i + 2 + k);
      }
      edits.push(
        editOf((tree) => {
          if (!isSafePath(path)) throw new EditFailure('unsafe', path);
          if (tree.get(path) === null) throw new EditFailure('missing', path);
          tree.set(path, null);
        }),
      );
    } else {
      // Update File: an optional `*** Move to: ` first line, then chunks.
      let moveTo: string | null = null;
      let at = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (at < body.length) {
        const l = body[at]!;
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseFailure(i + 2 + at);
          cur.eof = true;
          closeChunk();
          at += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = {
            anchor: anchorText === '' ? null : anchorText,
            chunk: { O: [], N: [], ctx: new Map() },
            eof: false,
          };
          at += 1;
          continue;
        }
        if (isV4ABodyLine(l)) {
          if (cur === null) {
            if (chunks.length !== 0) {
              // A body line cannot start a chunk after the first one.
              throw new ParseFailure(i + 2 + at);
            }
            cur = { anchor: null, chunk: { O: [], N: [], ctx: new Map() }, eof: false };
          }
          addV4ABodyLine(cur, l);
          at += 1;
          continue;
        }
        throw new ParseFailure(i + 2 + at);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseFailure(headLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = end;
  }
  return edits;
}

/** One V4A Update File section as an edit (SPEC section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  const isMove = moveTo !== null && moveTo !== path;
  return editOf((tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFailure('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const doc = parseDoc(before);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const vc of chunks) {
      // An anchor first finds the first line at or after the cursor equal to it, at the
      // first tier where one is; the cursor moves past it.
      if (vc.anchor !== null) {
        const tier = firstTierWith([vc.anchor], lines, cursor, strict);
        if (tier < 0) throw new EditFailure('no-match', path);
        const occ = occurrencesAt([vc.anchor], lines, tier, cursor);
        cursor = occ[0]! + 1;
      }
      const { O, N } = vc.chunk;
      if (O.length === 0) {
        const at = vc.eof ? lines.length : cursor;
        const rendered = renderNew(vc.chunk, lines, at, 0);
        lines.splice(at, 0, ...rendered);
        cursor = at + rendered.length;
        continue;
      }
      const tier = firstTierWith(O, lines, cursor, strict);
      if (tier < 0) throw new EditFailure('no-match', path);
      const occ = occurrencesAt(O, lines, tier, cursor);
      let at: number | null = null;
      if (vc.eof) {
        for (const pos of occ) {
          if (pos + O.length === lines.length) {
            at = pos;
            break;
          }
        }
      } else {
        at = occ[0]!;
      }
      if (at === null) throw new EditFailure('no-match', path);
      const rendered = renderNew(vc.chunk, lines, at, tier);
      lines.splice(at, O.length, ...rendered);
      cursor = at + rendered.length;
    }
    const out = renderDoc({ lines, br: doc.br, endsBreak: doc.endsBreak });
    const target = moveTo ?? path;
    tree.set(target, out);
    if (isMove) tree.set(path, null);
  }, isMove ? { from: path, to: moveTo! } : null);
}

/** Run the CLI on `args`. Returns the exit code and the lines for standard output. */
function run(args: string[]): { code: number; out: string[] } {
  const opts = parseArgs(args);
  if (opts === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  try {
    text = readFileSync(opts.patchFile ?? 0, 'utf8');
  } catch {
    if (opts.patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = readJson(text, lines);
    else if (kind === 'unified') edits = readUnified(lines, opts.strict);
    else if (kind === 'search-replace') edits = readSR(lines, opts.strict);
    else edits = readV4A(lines, opts.strict);
    if (edits.length === 0) throw new ParseFailure(1);
  } catch (e) {
    if (e instanceof ParseFailure) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit.apply(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // The rows for the paths whose state changed, in byte order of the paths. A move
  // that succeeded prints an `R` line (sorting by its new path) instead of the pair's
  // `D` and `A` lines.
  const rCovered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const edit of edits) {
    if (edit.move === null) continue;
    const { from, to } = edit.move;
    if (
      tree.original(from) !== null &&
      tree.get(from) === null &&
      tree.original(to) === null &&
      tree.get(to) !== null
    ) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      rCovered.add(from);
      rCovered.add(to);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (rCovered.has(p)) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!opts.check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each
  // one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
