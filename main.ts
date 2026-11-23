// mend — one patch tool for every AI edit format.
//
// Node 22, standard library only. Run as: node main.ts [options] [PATCH].
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none, printing what
// it changed or why it failed. SPEC.md is the whole contract.
//
// When MAKEFUN_ENV_URL is set, the trial runner takes over instead; see
// the last lines of this file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse-level failure: exit 2 with exactly this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: reported on exit 1 as `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed per line, and
 *  the empty piece after a final `\n` dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Spaces and tabs around a value. */
function trimSpaces(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One line compared at a matching tier. */
function normLine(s: string, tier: number): string {
  if (tier === 1) return stripEnd(s);
  if (tier === 2) return stripBoth(s);
  return s;
}

/** A file as lines: its own break, its lines, and whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function writeState(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

/** The tree as the edits leave it. `now` holds changed paths (null: deleted);
 *  everything else is read from disk, once, and never changes mid-run. */
class Tree {
  private origCache = new Map<string, string | null>();
  private diskCache = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];

  original(p: string): string | null {
    let v = this.origCache.get(p);
    if (v === undefined) {
      v = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return v;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** Something (file or directory) sits at this path on disk. */
  onDisk(p: string): boolean {
    let v = this.diskCache.get(p);
    if (v === undefined) {
      try {
        statSync(p);
        v = true;
      } catch {
        v = false;
      }
      this.diskCache.set(p, v);
    }
    return v;
  }

  /** A file can be created here only when nothing is in the way. */
  present(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.onDisk(p);
  }
}

type EditFn = (tree: Tree) => void;

/** One body line of a hunk or chunk: context, old, new, or backslash. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function bodyLineOf(raw: string): BodyLine | null {
  if (raw === '') return { kind: ' ', text: '' };
  const c = raw[0]!;
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return { kind: c, text: raw.slice(1) };
  return null;
}

/** Split a hunk or chunk body into its old lines and its new lines. A new
 *  line that is a context line carries the index of its old line, so it is
 *  written as the file's own matched line, never the patch's. */
function splitBody(body: BodyLine[]): { oldLines: string[]; newItems: { text: string; ctx: number | null }[] } {
  const oldLines: string[] = [];
  const newItems: { text: string; ctx: number | null }[] = [];
  for (const e of body) {
    if (e.kind === ' ') {
      const idx = oldLines.length;
      oldLines.push(e.text);
      newItems.push({ text: e.text, ctx: idx });
    } else if (e.kind === '-') {
      oldLines.push(e.text);
    } else if (e.kind === '+') {
      newItems.push({ text: e.text, ctx: null });
    }
  }
  return { oldLines, newItems };
}

/** True when a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const e = body[i]!;
    if (e.kind === ' ' || e.kind === '+') {
      const next = body[i + 1];
      return next !== undefined && next.kind === '\\';
    }
  }
  return false;
}

/** All positions at or after `from` where `old` occurs, at one tier; with
 *  `eof`, only occurrences ending at the file's last line. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number, eof: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    if (eof && i + old.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at least once, with its positions. */
function findTier(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, old, t, from, eof);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** Re-indent one new line at tier 2: the leading whitespace P of the old
 *  first line is replaced by the file's F, where the line starts with P. */
function reindent(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/** The lines that replace a match: context lines as the file's own lines,
 *  other lines re-indented at tier 2 and as they are at tiers 0 and 1. */
function buildNew(
  oldLines: string[],
  newItems: { text: string; ctx: number | null }[],
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  const out: string[] = [];
  const p = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  const f = fileLines.length > at ? leadWs(fileLines[at]!) : '';
  for (const item of newItems) {
    if (item.ctx !== null) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    out.push(tier === 2 ? reindent(item.text, p, f) : item.text);
  }
  return out;
}

/** Detect the patch format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
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

/** Apply hunks to a file's lines (SPEC.md section 6). */
function applyHunks(st: FileState, hunks: { a: number; body: BodyLine[] }[], strict: boolean, path: string): FileState {
  const lines = [...st.lines];
  let finalBreak = st.finalBreak;
  let d = 0;
  for (const hunk of hunks) {
    const { oldLines, newItems } = splitBody(hunk.body);
    if (oldLines.length === 0) {
      const at = Math.min(hunk.a + d, lines.length);
      const added = newItems.map((n) => n.text);
      lines.splice(at, 0, ...added);
      if (at === lines.length) finalBreak = !backslashAfterLast(hunk.body);
      d += added.length;
      continue;
    }
    const found = findTier(lines, oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const replacement = buildNew(oldLines, newItems, lines, pos, found.tier);
    const toEnd = pos + oldLines.length === lines.length;
    lines.splice(pos, oldLines.length, ...replacement);
    if (toEnd) finalBreak = !backslashAfterLast(hunk.body);
    d += replacement.length - oldLines.length;
  }
  return { br: st.br, lines, finalBreak };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hasPair: boolean;
  hunks: { a: number; body: BodyLine[] }[];
}

/** The path a `--- ` or `+++ ` line names, or null for `/dev/null`. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s === '/dev/null') return null;
  return s;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: { a: number; body: BodyLine[] } | null = null;
  let inHeader = false;
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === ' ' && last.text === '') hunk.body.pop();
      else break;
    }
    hunk = null;
  };
  const newSection = (gitOld: string | null, gitNew: string | null, pair: boolean): Section => {
    const s: Section = {
      oldPath: null,
      newPath: null,
      gitOld,
      gitNew,
      renameFrom: null,
      renameTo: null,
      isCreate: false,
      isDelete: false,
      hasPair: pair,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      const endsBody =
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
      if (!endsBody) {
        const entry = bodyLineOf(line);
        if (entry !== null) {
          hunk.body.push(entry);
          i++;
          continue;
        }
      }
      closeHunk();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!, false);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        const s = newSection(null, null, true);
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  closeHunk();
  return sections;
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedEdits(sections: Section[], strict: boolean): EditFn[] {
  return sections.map((sec) => (tree: Tree) => {
    const oldP = sec.hasPair ? sec.oldPath : sec.renameFrom ?? sec.gitOld;
    const newP = sec.hasPair ? sec.newPath : sec.renameTo ?? sec.gitNew;
    const isCreate = oldP === null || sec.isCreate;
    if (isCreate) {
      const path = newP ?? '';
      if (!isSafe(path)) throw new Fail('unsafe', path);
      if (tree.present(path)) throw new Fail('exists', path);
      const added: string[] = [];
      let finalBreak = true;
      let lastPlus: { hunk: { body: BodyLine[] }; idx: number } | null = null;
      for (const hunk of sec.hunks) {
        for (let k = 0; k < hunk.body.length; k++) {
          if (hunk.body[k]!.kind === '+') {
            added.push(hunk.body[k]!.text);
            lastPlus = { hunk, idx: k };
          }
        }
      }
      if (lastPlus !== null) {
        const next = lastPlus.hunk.body[lastPlus.idx + 1];
        finalBreak = !(next !== undefined && next.kind === '\\');
      }
      tree.now.set(path, added.length === 0 ? '' : added.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    const isDelete = newP === null || sec.isDelete;
    if (isDelete) {
      const path = oldP ?? '';
      if (!isSafe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (oldP !== newP) {
      const from = oldP ?? '';
      const to = newP ?? '';
      if (!isSafe(from)) throw new Fail('unsafe', from);
      if (!isSafe(to)) throw new Fail('unsafe', to);
      const text = tree.get(from);
      if (text === null) throw new Fail('missing', from);
      if (tree.present(to)) throw new Fail('exists', to);
      const out = writeState(applyHunks(readState(text), sec.hunks, strict, from));
      tree.now.set(to, out);
      tree.now.set(from, null);
      tree.moves.push({ from, to });
      return;
    }
    const path = oldP ?? '';
    if (!isSafe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    tree.now.set(path, writeState(applyHunks(readState(text), sec.hunks, strict, path)));
  });
}

interface SrBlock {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let k = s + 1;
    for (; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    let m = sep + 1;
    for (; m < lines.length; m++) {
      if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
        end = m;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, sep), next: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function searchReplaceEdits(blocks: SrBlock[], strict: boolean): EditFn[] {
  return blocks.map(
    (b) => (tree: Tree) => {
      if (!isSafe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.present(b.path)) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new Fail('missing', b.path);
      const st = readState(text);
      const found = findTier(st.lines, b.old, 0, strict, false);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.positions[0]!;
      const items = b.next.map((t) => ({ text: t, ctx: null as number | null }));
      const replacement = buildNew(b.old, items, st.lines, pos, found.tier);
      st.lines.splice(pos, b.old.length, ...replacement);
      tree.now.set(b.path, writeState(st));
    },
  );
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function sectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: trimSpaces(line.slice(14)) };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: trimSpaces(line.slice(17)) };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: trimSpaces(line.slice(17)) };
  return null;
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const head = sectionStart(line);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const raw: string[] = [];
    i++;
    while (i < last && sectionStart(lines[i]!) === null) {
      raw.push(lines[i]!);
      i++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    const sec: V4aSection = {
      kind: head.kind,
      path: head.path,
      startLine: i - raw.length,
      lines: raw,
      moveTo: null,
      chunks: [],
    };
    if (head.kind === 'add') {
      sec.lines = raw.map((l, k) => {
        if (l.startsWith('+')) return l.slice(1);
        if (l === '') return '';
        throw new Exit2(`error: parse ${sec.startLine + k}`);
      });
    } else if (head.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${sec.startLine}`);
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        sec.moveTo = trimSpaces(raw[0]!.slice(13));
        idx = 1;
      }
      let cur: V4aChunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < raw.length; idx++) {
        const text = raw[idx]!;
        const num = sec.startLine + idx;
        if (text.startsWith('@@')) {
          close();
          cur = { anchor: trimSpaces(text.slice(2)), eof: false, body: [] };
        } else if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          close();
        } else {
          const entry = bodyLineOf(text);
          if (entry === null) throw new Exit2(`error: parse ${num}`);
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${num}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(entry);
        }
      }
      close();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.startLine}`);
    }
    sections.push(sec);
  }
  return sections;
}

/** The first line at or after `from` equal to an anchor, at the first tier
 *  where one is (both sides a single line). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < lines.length; j++) {
      if (normLine(lines[j]!, t) === normLine(anchor, t)) return j;
    }
  }
  return null;
}

/** One V4A section as an edit (SPEC.md section 8). */
function v4aEdits(sections: V4aSection[], strict: boolean): EditFn[] {
  return sections.map((sec) => (tree: Tree) => {
    if (sec.kind === 'add') {
      if (!isSafe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.present(sec.path)) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!isSafe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!isSafe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !isSafe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const text = tree.get(sec.path);
    if (text === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.present(sec.moveTo)) throw new Fail('exists', sec.moveTo);
    const st = readState(text);
    const lines = [...st.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const { oldLines, newItems } = splitBody(chunk.body);
      if (oldLines.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines.splice(at, 0, ...newItems.map((n) => n.text));
        cursor = at + newItems.length;
        continue;
      }
      const found = findTier(lines, oldLines, cursor, strict, chunk.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.positions[0]!;
      const replacement = buildNew(oldLines, newItems, lines, pos, found.tier);
      lines.splice(pos, oldLines.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const out = writeState({ br: st.br, lines, finalBreak: st.finalBreak });
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.present(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const st = readState(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, writeState(st));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    if (
      tree.original(mv.from) !== null &&
      tree.get(mv.from) === null &&
      tree.original(mv.to) === null &&
      tree.get(mv.to) !== null
    ) {
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      consumed.add(mv.from);
      consumed.add(mv.to);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
