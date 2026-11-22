// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Successful moves (old, new), for the R lines in the exit-0 output. */
const moves: Array<{ old: string; new: string }> = [];

/** A text file as lines: its line break, its lines, whether it ends with a break. */
interface FileModel {
  br: string;
  lines: string[];
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in F at the given tier, at or after `from`. */
function occurrences(tier: number, o: string[], f: string[], from: number, endAtLast: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= f.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(tier, o[j], f[i + j])) {
        ok = false;
        break;
      }
    }
    if (ok && (!endAtLast || i + o.length === f.length)) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence at or after `from`, with its positions. */
function findTier(strict: boolean, o: string[], f: string[], from: number, endAtLast: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(t, o, f, from, endAtLast);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of the replacement: a context line (taken from the file) or a new line. */
interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the replacement lines for a match at `at` with tier `tier`. */
function buildReplacement(items: NewItem[], f: string[], at: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  const fLead = tier === 2 ? leadingWs(f[at] ?? '') : '';
  const pLead = tier === 2 ? leadingWs(o[0] ?? '') : '';
  for (const it of items) {
    if (it.ctx) {
      out.push(f[at + it.oIdx]);
      continue;
    }
    let s = it.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(pLead)) s = fLead + s.slice(pLead.length);
    out.push(s);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
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
    if (blank(l)) return;
    let e: Edit | null = null;
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

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  type: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function parseUnifiedPath(s: string): string | null {
  const t = s.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return parseUnifiedPath(tab < 0 ? rest : rest.slice(0, tab));
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

function resolveUnified(sec: UnifiedSection): { oldPath: string | null; newPath: string | null } {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld !== undefined ? sec.gitOld : null;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew !== undefined ? sec.gitNew : null;
  return { oldPath, newPath };
}

function applyHunks(f: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const items: NewItem[] = [];
    let lastCtxPlus = -1;
    for (let k = 0; k < h.body.length; k++) {
      const bl = h.body[k];
      if (bl.type === 'ctx') {
        o.push(bl.text);
        items.push({ text: bl.text, ctx: true, oIdx: o.length - 1 });
        lastCtxPlus = k;
      } else if (bl.type === 'old') {
        o.push(bl.text);
      } else if (bl.type === 'new') {
        items.push({ text: bl.text, ctx: false, oIdx: -1 });
        lastCtxPlus = k;
      }
    }
    const noNl = lastCtxPlus >= 0 && lastCtxPlus + 1 < h.body.length && h.body[lastCtxPlus + 1].type === 'bs';
    if (o.length === 0) {
      const oldLen = f.lines.length;
      let p = h.a + d;
      if (p < 0) p = 0;
      if (p > oldLen) p = oldLen;
      const added = items.map((it) => it.text);
      f.lines.splice(p, 0, ...added);
      if (p === oldLen) f.ends = !noNl;
      d += added.length;
      continue;
    }
    const found = findTier(strict, o, f.lines, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const repl = buildReplacement(items, f.lines, best, found.tier, o);
    const runsToEnd = best + o.length === f.lines.length;
    f.lines.splice(best, o.length, ...repl);
    if (runsToEnd) f.ends = !noNl;
    d += repl.length - o.length;
  }
}

function makeUnifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const { oldPath, newPath } = resolveUnified(sec);
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = !isCreate && (newPath === null || sec.delFile);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const newLines: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const bl = h.body[k];
          if (bl.type === 'new') {
            newLines.push(bl.text);
            noNl = k + 1 < h.body.length && h.body[k + 1].type === 'bs';
          }
        }
      }
      const text = newLines.length === 0 ? '' : newLines.join('\n') + (noNl ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const oldP = oldPath as string;
      const newP = newPath as string;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(cur);
      applyHunks(f, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(f));
      moves.push({ old: oldP, new: newP });
      return;
    }
    const p = oldPath as string;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = parseFile(cur);
    applyHunks(f, sec.hunks, strict, p);
    tree.now.set(p, serializeFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let hasPair = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/');
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, sep);
      const y = rest.slice(sep + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined, gitOld: x, gitNew: y, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      hasPair = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        hasPair = true;
        i += 2;
        continue;
      }
      cur = { pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined, gitOld: undefined, gitNew: undefined, newFile: false, delFile: false, hunks: [] };
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]);
      sections.push(cur);
      inHeader = true;
      hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: BodyLine[] = [];
      while (j < n) {
        const l = lines[j];
        if (l.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (l === '') {
          body.push({ type: 'ctx', text: '' });
          j++;
          continue;
        }
        const c = l[0];
        if (c === ' ') {
          body.push({ type: 'ctx', text: l.slice(1) });
          j++;
          continue;
        }
        if (c === '-') {
          body.push({ type: 'old', text: l.slice(1) });
          j++;
          continue;
        }
        if (c === '+') {
          body.push({ type: 'new', text: l.slice(1) });
          j++;
          continue;
        }
        if (c === '\\') {
          body.push({ type: 'bs', text: l.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1].type === 'ctx' && body[body.length - 1].text === '') body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.now.set(path, text);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(strict, oldLines, f.lines, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0];
    const items: NewItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const repl = buildReplacement(items, f.lines, at, found.tier, oldLines);
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < n; j++) {
      if (lines[j].trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(makeSrEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function makeV4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    tree.now.set(path, text);
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: string[], secStart: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (idx < raw.length && raw[idx].startsWith('*** Move to: ')) {
    moveTo = raw[idx].slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  const lineNo = (k: number): number => secStart + 2 + k;
  for (let k = idx; k < raw.length; k++) {
    const l = raw[k];
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      started = true;
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
        started = true;
      }
      if (l === '') cur.body.push({ type: 'ctx', text: '' });
      else if (l.startsWith(' ')) cur.body.push({ type: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.body.push({ type: 'old', text: l.slice(1) });
      else cur.body.push({ type: 'new', text: l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${lineNo(k)}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secStart + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(strict, [ch.anchor], f.lines, cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0] + 1;
      }
      const o: string[] = [];
      const items: NewItem[] = [];
      for (const bl of ch.body) {
        if (bl.type === 'ctx') {
          o.push(bl.text);
          items.push({ text: bl.text, ctx: true, oIdx: o.length - 1 });
        } else if (bl.type === 'old') {
          o.push(bl.text);
        } else if (bl.type === 'new') {
          items.push({ text: bl.text, ctx: false, oIdx: -1 });
        }
      }
      if (o.length === 0) {
        const p = ch.eof ? f.lines.length : cursor;
        const added = items.map((it) => it.text);
        f.lines.splice(p, 0, ...added);
        cursor = p + added.length;
      } else {
        const found = findTier(strict, o, f.lines, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.positions[0];
        const repl = buildReplacement(items, f.lines, at, found.tier, o);
        f.lines.splice(at, o.length, ...repl);
        cursor = at + repl.length;
      }
    }
    const text = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const line = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secStart = i;
    i++;
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${secStart + 2 + k}`);
      }
      edits.push(makeV4aAdd(path, fileLines));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${secStart + 2}`);
      edits.push(makeV4aDelete(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, secStart, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rMoves = moves.filter((m) => tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null);
  const rOld = new Set(rMoves.map((m) => m.old));
  const rNew = new Set(rMoves.map((m) => m.new));
  const rows: Array<{ key: string; text: string }> = [];
  for (const m of rMoves) rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!rOld.has(p) && !rNew.has(p)) rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
