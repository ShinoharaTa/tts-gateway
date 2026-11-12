/**
 * 読み辞書（英字の語 → カタカナ）。前処理（spoken.ts）の後で、文の語を読みに置き換える（docs/api.md「読み辞書の規則」）。
 *
 * - 照合は NFKC + 大文字小文字を同一視。単語境界は、前が英数字でないこと・後ろが英字でないこと（iPhone16 → アイフォーン16）。
 *   長い surface から当てる（Hugging Face を Hugging より先に）。URL・メールアドレス・ドメイン（example.com）の中は置き換えない
 * - 全部大文字で 5 字以内の語（API, AWS, GPU, PS5）は頭字語として置き換えない（ZEN-TTS の略語規則に任せる）
 * - 置き換えた語の直後の所有格 's は消し、「-数字」「-英字」はハイフンを空白にする（Pixel-9 → ピクセル 9。マイナスと読ませない）
 * - 辞書は 組み込み（dict/readings.tsv）・ユーザー（データディレクトリの readings.tsv）・要求ごと（readings）の 3 つ。
 *   同じ語なら 要求 → ユーザー → 組み込み の順で優先する
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from '../settings.ts';
import { EMAIL_RE, URL_RE } from './spoken.ts';

export const READING_SOURCES = ['request', 'user', 'builtin'] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];
export type ReadingRow = { surface: string; reading: string; source: ReadingSource };

/** 保存する形。NFKC、前後の空白を落とし、連続する空白を 1 つに */
export const normalizeSurface = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ');
/** 照合のキー（大文字小文字を同一視） */
export const surfaceKey = (s: string): string => normalizeSurface(s).toLowerCase();

/** 全部大文字で 5 字以内（数字を含んでよい。先頭は英字）。綴りで読むので置き換えない */
export const isAcronym = (word: string): boolean => /^[A-Z][A-Z0-9]{0,4}$/.test(word);

/** 読みとして受け付ける形（カタカナ・長音符・中黒・空白） */
export const isReading = (s: string): boolean => /^[\p{Script=Katakana}ー・ ]+$/u.test(s) && /\p{Script=Katakana}/u.test(s);

const ALNUM_RE = /[A-Za-z0-9]/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * http の無いドメイン（example.com、github.com/foo、x.com）。URL と同じく置き換えず、未知語の候補にもしない。
 * 末尾がよくある TLD のものだけ（Next.js・Node.js を巻き込まない）
 */
export const DOMAIN_RE =
  /(?<![A-Za-z0-9@.-])(?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|jp|co|me|tv|gg|so|sh|xyz|info|cloud|tech)(?![A-Za-z0-9-])(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;

/** surface 1 つの正規表現。空白は 1 つ以上の空白に。先頭が英数字なら前が英数字でないとき、末尾が英字なら後ろが英字でないとき（iPhone16 は当てる） */
const surfacePattern = (surface: string): string => {
  const body = surface.split(' ').map(escapeRe).join('\\s+');
  const head = ALNUM_RE.test(surface[0]!) ? '(?<![A-Za-z0-9])' : '';
  const last = surface.at(-1)!;
  const tail = /[A-Za-z]/.test(last) ? '(?![A-Za-z])' : /\d/.test(last) ? '(?![A-Za-z0-9])' : '';
  return `${head}${body}${tail}`;
};

/** 語の直後: 所有格 's は消す（Apple's → アップル）。-数字・-英字のハイフンは空白にする（Pixel-9 → ピクセル 9、Mac-mini → マック ミニ） */
const SUFFIX = `(?:(['’]s(?![A-Za-z]))|(-(?=[A-Za-z0-9])))?`;

/**
 * 照合の候補を絞るための文字のキー。/iu で同じとみなす文字は必ず同じキーになる（逆は成り立たなくてよい）。
 * ASCII は小文字（/iu で ASCII と同じになる非 ASCII は K（ケルビン）と ſ だけ）。大文字小文字の無い文字はその文字。
 * 大文字小文字のある非 ASCII（é・σ など）は null（照合のたびに /iu で比べる）
 */
const CASED_RE = /[\p{Changes_When_Casemapped}\p{Changes_When_Casefolded}]/u;
const SPACE_RE = /\s/;
/** 空白（\s）はどれも ' ' */
const charKey = (ch: string): string | null => {
  if (SPACE_RE.test(ch)) return ' ';
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch.toLowerCase();
  if (ch === 'K') return 'k';
  if (ch === 'ſ') return 's';
  return CASED_RE.test(ch) ? null : ch;
};
const ASCII_KEYS = Array.from({ length: 0x80 }, (_, c) => charKey(String.fromCharCode(c)));
/** 非 ASCII の charKey の控え（大きくなりすぎたら捨てる） */
const charKeys = new Map<string, string | null>();
const charKeyCached = (ch: string): string | null => {
  let key = charKeys.get(ch);
  if (key === undefined) {
    if (charKeys.size >= 50_000) charKeys.clear();
    charKeys.set(ch, (key = charKey(ch)));
  }
  return key;
};
/** s の位置 i の文字（サロゲートペアは 2 単位で 1 文字。/u と同じ） */
const charAt = (s: string, i: number): string => {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i]!;
};
const keyOf = (ch: string): string | null => {
  const c = ch.charCodeAt(0);
  return ch.length === 1 && c < 0x80 ? ASCII_KEYS[c]! : charKeyCached(ch);
};

/**
 * surface の木。辺は charKey（大文字小文字のある非 ASCII は cased に元の文字のまま）。空白は ' ' 1 つ（文の空白の並びに当たる）。
 * free: この下に、前が英数字でもよい（先頭が英数字でない）surface がある
 */
type TrieNode = { next: Map<string, TrieNode>; cased: [string, TrieNode][]; ends: number[]; free: boolean };
const trieNode = (): TrieNode => ({ next: new Map(), cased: [], ends: [], free: false });

/** 英単語の候補（英字の並び。. ' - でつながる英字は 1 語） */
const WORD_RE = /(?<![A-Za-z0-9])[A-Za-z]+(?:['’.-][A-Za-z]+)*(?![A-Za-z])/g;

const sha256 = (lines: string[]): string => createHash('sha256').update(lines.join('\n')).digest('hex');

export type UnknownWord = { word: string; count: number };
export type Hit = { surface: string; reading: string };

export type Readings = {
  /** 置き換えに使う読み（キー → 読み）の sha256 */
  version: string;
  /** 置き換えに使う読みの数 */
  size: number;
  /** 置き換えに使う語（同じキーは優先度の高い 1 つ）。source 付き */
  entries: () => ReadingRow[];
  /** 文の英語の語を読みに置き換える（NFKC 済みの文を返す） */
  apply: (text: string) => string;
  /** texts で実際に当たった語（キー → 読み。当たった順） */
  hits: (texts: readonly string[]) => Hit[];
  /** 辞書に無い、小文字を含む英単語（所有格 's は落とす）。多い順 */
  unknownWords: (texts: readonly string[]) => UnknownWord[];
};

const SOURCE_RANK: Record<ReadingSource, number> = { request: 0, user: 1, builtin: 2 };

/** 辞書を作る。同じキーの行が複数あれば request → user → builtin の順で 1 つ選ぶ（同じ source なら後の行） */
export const compileReadings = (rows: readonly ReadingRow[]): Readings => {
  const known = new Set<string>();
  const chosen = new Map<string, { surface: string; reading: string; source: ReadingSource; rank: number }>();
  for (const row of rows) {
    const surface = normalizeSurface(row.surface);
    if (!surface) continue;
    const key = surface.toLowerCase();
    known.add(key);
    const reading = row.reading.trim();
    if (!isReading(reading) || isAcronym(surface)) continue;
    const rank = SOURCE_RANK[row.source] ?? 3;
    const prev = chosen.get(key);
    if (!prev || rank <= prev.rank) chosen.set(key, { surface, reading, source: row.source, rank });
  }
  const sorted = [...chosen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const version = sha256(sorted.map(([key, e]) => `${key}\t${e.reading}`));
  // 照合の優先順（長い surface から。同じ長さならキーの順）
  const byLength = sorted.map(([, e]) => e.surface).sort((a, b) => b.length - a.length);

  /*
   * 照合は「URL・メール・ドメイン | surface（優先順）」を 1 本の正規表現（giu）で当てるのと同じ結果にする。
   * surface の数 × 位置の数だけ正規表現を試すと遅い（surface 200 語 × 2,000 字で数秒）ので、
   * 各位置で surface の木をたどって当たりうる語だけに絞り、その語の正規表現（同じ形・同じフラグ）で優先順に確かめる
   */
  const specialRe = new RegExp(`(${URL_RE.source})|(${EMAIL_RE.source})|(${DOMAIN_RE.source})`, 'giu');
  const root = trieNode();
  const needsHead = byLength.map(s => ALNUM_RE.test(s[0]!));
  for (const [i, surface] of byLength.entries()) {
    let node = root;
    for (const ch of surface) {
      const key = keyOf(ch);
      let child: TrieNode | undefined;
      if (key === null) {
        child = node.cased.find(([c]) => c === ch)?.[1];
        if (!child) node.cased.push([ch, (child = trieNode())]);
      } else {
        child = node.next.get(key);
        if (!child) node.next.set(key, (child = trieNode()));
      }
      node = child;
      if (!needsHead[i]) node.free = true;
    }
    node.ends.push(i);
  }
  const surfaceRes = new Map<number, RegExp>();
  const surfaceRe = (i: number): RegExp => {
    let re = surfaceRes.get(i);
    if (!re) surfaceRes.set(i, (re = new RegExp(`(${surfacePattern(byLength[i]!)})${SUFFIX}`, 'iuy')));
    return re;
  };
  // 大文字小文字のある非 ASCII 文字どうしを /iu で比べた結果
  const casedEq = new Map<string, Map<string, boolean>>();
  const sameCased = (a: string, b: string): boolean => {
    let row = casedEq.get(a);
    if (!row) casedEq.set(a, (row = new Map()));
    let eq = row.get(b);
    if (eq === undefined) row.set(b, (eq = new RegExp(`^${escapeRe(a)}$`, 'iu').test(b)));
    return eq;
  };

  /** node から s の位置 i 以降をたどり、当たりうる surface を candidates に足す。prevAlnum: 照合の始まりの前が英数字 */
  const walk = (s: string, node: TrieNode, i: number, prevAlnum: boolean, candidates: number[]): void => {
    for (;;) {
      for (const e of node.ends) if (!(prevAlnum && needsHead[e])) candidates.push(e);
      if (i >= s.length) return;
      const c = s.charCodeAt(i);
      const ch = c < 0x80 ? '' : charAt(s, i);
      const key = c < 0x80 ? ASCII_KEYS[c]! : charKeyCached(ch);
      let j = i + (c < 0x80 ? 1 : ch.length);
      if (key === ' ') while (j < s.length && keyOf(s[j]!) === ' ') j++;
      let child: TrieNode | undefined;
      if (key !== null) {
        child = node.next.get(key);
      } else {
        // 大文字小文字のある非 ASCII は当たる辺が複数ありうる（2 つ目からは別にたどる）
        for (const [edge, n] of node.cased) {
          if ((prevAlnum && !n.free) || !sameCased(edge, ch)) continue;
          if (!child) child = n;
          else walk(s, n, j, prevAlnum, candidates);
        }
      }
      if (!child || (prevAlnum && !child.free)) return;
      node = child;
      i = j;
    }
  };

  /** 位置 p から当たる surface（優先順で最初のもの）の match。無ければ null */
  const matchWordAt = (s: string, p: number): RegExpExecArray | null => {
    // 先頭が英数字の surface は、前が英数字なら当たらない（surfacePattern の head）
    const prevAlnum = p > 0 && ALNUM_RE.test(s[p - 1]!);
    const candidates: number[] = [];
    walk(s, root, p, prevAlnum, candidates);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    for (const e of candidates) {
      const re = surfaceRe(e);
      re.lastIndex = p;
      const m = re.exec(s);
      if (m) return m;
    }
    return null;
  };

  /** 置き換え。onHit に当たった語を渡す */
  const replace = (text: string, onHit?: (key: string, reading: string) => void): string => {
    const nfkc = text.normalize('NFKC');
    if (!byLength.length) return nfkc;
    let out = '';
    let copied = 0;
    let p = 0;
    // p 以降で最初の URL・メール・ドメイン（undefined はまだ探していない）
    let special: RegExpExecArray | null | undefined;
    while (p < nfkc.length) {
      if (special === undefined || (special && special.index < p)) {
        specialRe.lastIndex = p;
        special = specialRe.exec(nfkc);
      }
      const stop = special ? special.index : nfkc.length;
      let m: RegExpExecArray | null = null;
      for (; p < stop; p += nfkc.codePointAt(p)! > 0xffff ? 2 : 1) if ((m = matchWordAt(nfkc, p))) break;
      if (m) {
        const whole = m[0];
        const [, word, , hyphen] = m;
        let replacement = whole;
        if (word && !isAcronym(word)) {
          const key = word.replace(/\s+/g, ' ').toLowerCase();
          const e = chosen.get(key);
          if (e) {
            onHit?.(key, e.reading);
            replacement = hyphen ? `${e.reading} ` : e.reading;
          }
        }
        out += nfkc.slice(copied, p) + replacement;
        p = copied = p + whole.length;
        continue;
      }
      if (!special) break;
      // URL・メール・ドメインはそのまま
      p = special.index + special[0].length;
      special = undefined;
    }
    return out + nfkc.slice(copied);
  };

  const apply = (text: string): string => replace(text);

  const hits = (texts: readonly string[]): Hit[] => {
    const out = new Map<string, string>();
    for (const text of texts) replace(text, (key, reading) => out.set(key, reading));
    return [...out].map(([surface, reading]) => ({ surface, reading }));
  };

  const unknownWords = (texts: readonly string[]): UnknownWord[] => {
    const counts = new Map<string, UnknownWord>();
    for (const text of texts) {
      const rest = apply(text).replace(URL_RE, ' ').replace(EMAIL_RE, ' ').replace(DOMAIN_RE, ' ');
      for (const [match] of rest.matchAll(WORD_RE)) {
        const word = match.replace(/['’]s$/, '');
        if (word.length < 2 || !/[a-z]/.test(word) || isAcronym(word)) continue;
        const key = word.toLowerCase();
        if (known.has(key)) continue;
        const hit = counts.get(key);
        if (hit) hit.count++;
        else counts.set(key, { word, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  };

  const entries = (): ReadingRow[] => sorted.map(([, e]) => ({ surface: e.surface, reading: e.reading, source: e.source }));

  return { version, size: sorted.length, entries, apply, hits, unknownWords };
};

/** readings.tsv（surface<TAB>reading、# はコメント）を読む。読みの形が不正な行は飛ばす */
export const parseReadingsTsv = (tsv: string, source: ReadingSource = 'builtin'): ReadingRow[] =>
  tsv
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.split('\t'))
    .filter(([surface, reading]) => surface?.trim() && reading && isReading(reading.trim()))
    .map(([surface, reading]) => ({ surface: normalizeSurface(surface!), reading: reading!.trim(), source }));

const USER_TSV_HEADER =
  '# tts-gateway のユーザー辞書。surface<TAB>reading。設定画面か PUT/DELETE /v1/admin/dictionary/{surface} で変える。\n' +
  '# 組み込みの辞書（dict/readings.tsv）と同じ語なら、こちらが優先する。\n';

/**
 * 組み込み + ユーザーの辞書。ユーザー辞書の変更はファイルに原子的に書く（.tmp → rename）。
 * 要求ごとの readings は withRequest で重ねる（辞書そのものは変えない）
 */
export class Dictionary {
  readonly builtin: ReadingRow[];
  private user: ReadingRow[];
  private readonly userPath: string;
  private compiled: Readings;
  private writing: Promise<void> = Promise.resolve();

  constructor(builtin: ReadingRow[], user: ReadingRow[], userPath: string) {
    this.builtin = builtin;
    this.user = user;
    this.userPath = userPath;
    this.compiled = compileReadings([...builtin, ...user]);
  }

  static async load(builtinPath: string, userPath: string): Promise<Dictionary> {
    const builtin = parseReadingsTsv(readFileSync(builtinPath, 'utf8'), 'builtin');
    let user: ReadingRow[] = [];
    try {
      user = parseReadingsTsv(await readFile(userPath, 'utf8'), 'user');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return new Dictionary(builtin, user, userPath);
  }

  get readings(): Readings {
    return this.compiled;
  }

  /** この要求だけの readings を重ねた辞書 */
  withRequest(readings: Record<string, string>): Readings {
    const extra = Object.entries(readings).map(([surface, reading]) => ({ surface, reading, source: 'request' as const }));
    if (extra.length === 0) return this.compiled;
    return compileReadings([...this.builtin, ...this.user, ...extra]);
  }

  hasUser(surface: string): boolean {
    const key = surfaceKey(surface);
    return this.user.some(r => surfaceKey(r.surface) === key);
  }

  /** GET /v1/dictionary の形 */
  toJSON(): { version: string; entries: ReadingRow[] } {
    return { version: this.compiled.version, entries: this.compiled.entries() };
  }

  async set(surface: string, reading: string): Promise<void> {
    const s = normalizeSurface(surface);
    const key = s.toLowerCase();
    this.user = [...this.user.filter(r => surfaceKey(r.surface) !== key), { surface: s, reading: reading.trim(), source: 'user' }];
    await this.save();
  }

  /** ユーザー辞書から消す。無ければ false */
  async delete(surface: string): Promise<boolean> {
    const key = surfaceKey(surface);
    const next = this.user.filter(r => surfaceKey(r.surface) !== key);
    if (next.length === this.user.length) return false;
    this.user = next;
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    this.compiled = compileReadings([...this.builtin, ...this.user]);
    const body = USER_TSV_HEADER + this.user.map(r => `${r.surface}\t${r.reading}\n`).join('');
    // 書き込みは順に（後の変更が先の変更に上書きされないように）
    this.writing = this.writing.catch(() => {}).then(() => writeAtomic(this.userPath, body));
    return this.writing;
  }
}
