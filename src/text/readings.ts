/**
 * 読み辞書（英字の語 → カタカナ）。前処理の前の段（spoken.ts の beforeReadings: NFKC・URL とメールの削除）と
 * 後の段（afterReadings: 記号の規則）の間で、文の語を読みに置き換える（docs/api.md「読み辞書の規則」）。
 *
 * - 照合は NFKC + 大文字小文字を同一視。単語境界は、前が英数字でないこと・後ろが英字でないこと（iPhone16 → アイフォーン16）。
 *   長い surface から当てる（Hugging Face を Hugging より先に）。URL・メールアドレス・ドメイン（example.com）の中は置き換えない。
 *   ただし surface 自体がドットを含む語（Character.AI、Booking.com）はドメインの形でも当てる
 * - 登録した語は全部大文字でも置き換える（NASA、API）。未知語の候補からは全部大文字 3 字以内（API, GPU）を除く（ZEN-TTS が綴りで読む）
 * - surface の語の間の空白は改行をまたがない（行末の MacBook と次の行頭の Pro を 1 語にしない）
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

/** 全部大文字で 5 字以内（数字を含んでよい。先頭は英字）。ユーザー辞書への登録を断るのに使う（server.ts） */
export const isAcronym = (word: string): boolean => /^[A-Z][A-Z0-9]{0,4}$/.test(word);

/** 全部大文字で 3 字以内（API, GPU）。ZEN-TTS が綴りで読むので未知語の候補にしない */
const isSpelledAcronym = (word: string): boolean => /^[A-Z]{1,3}$/.test(word);

/** 読みとして受け付ける形（全角カタカナ・長音符・中黒・空白。半角カナは不可） */
export const isReading = (s: string): boolean => /^[\u30A1-\u30FA\u30FD\u30FEー・ ]+$/.test(s) && /[\u30A1-\u30FA]/.test(s);

const ALNUM_RE = /[A-Za-z0-9]/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * http の無いドメイン（example.com、github.com/foo、x.com）。URL と同じく置き換えず、未知語の候補にもしない。
 * 末尾がよくある TLD のものだけ（Next.js・Node.js を巻き込まない）
 */
export const DOMAIN_RE =
  /(?<![A-Za-z0-9@.-])(?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|jp|co|me|tv|gg|so|sh|xyz|info|cloud|tech)(?![A-Za-z0-9-])(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;

/** surface 1 つの正規表現。空白は 1 つ以上の空白（改行は含めない）に。先頭が英数字なら前が英数字でないとき、末尾が英字なら後ろが英字でないとき（iPhone16 は当てる） */
const surfacePattern = (surface: string): string => {
  const body = surface.split(' ').map(escapeRe).join('[ \\t\\u3000]+');
  const head = ALNUM_RE.test(surface[0]!) ? '(?<![A-Za-z0-9])' : '';
  const last = surface.at(-1)!;
  const tail = /[A-Za-z]/.test(last) ? '(?![A-Za-z])' : /\d/.test(last) ? '(?![A-Za-z0-9])' : '';
  return `${head}${body}${tail}`;
};

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
  /** 辞書に無い英単語（所有格 's は落とす。全部大文字 3 字以内は除く）。多い順 */
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
    if (!isReading(reading)) continue;
    const rank = SOURCE_RANK[row.source] ?? 3;
    const prev = chosen.get(key);
    if (!prev || rank <= prev.rank) chosen.set(key, { surface, reading, source: row.source, rank });
  }
  const sorted = [...chosen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const version = sha256(sorted.map(([key, e]) => `${key}\t${e.reading}`));
  const byLength = sorted.map(([, e]) => e.surface).sort((a, b) => b.length - a.length);
  // ドットを含む surface（Character.AI）はドメインより先に試す。ただし長いドメインの一部（character.ai.example.com）は除く。
  // それ以外はドメインの後（example.com の example は当てない）
  const dotted = byLength.filter(s => s.includes('.'));
  const plain = byLength.filter(s => !s.includes('.'));
  const group = (list: string[]): string => (list.length ? list.map(surfacePattern).join('|') : '(?!)');
  const dottedGroup = dotted.length ? `(?<![.@])(?:${group(dotted)})(?!\\.[A-Za-z0-9])` : '(?!)';
  // 語の直後: 所有格 's は消す（Apple's → アップル）。-数字・-英字のハイフンは空白にする（Pixel-9 → ピクセル 9、Mac-mini → マック ミニ）
  const re = byLength.length
    ? new RegExp(
        `(${URL_RE.source})|(${EMAIL_RE.source})|(${dottedGroup})|(${DOMAIN_RE.source})|(${group(plain)})` +
          `(?:(['’]s(?![A-Za-z]))|(-(?=[A-Za-z0-9])))?`,
        'giu',
      )
    : null;

  /** 置き換え。onHit に当たった語を渡す */
  const replace = (text: string, onHit?: (key: string, reading: string) => void): string => {
    const nfkc = text.normalize('NFKC');
    if (!re) return nfkc;
    return nfkc.replace(
      re,
      (m: string, url?: string, email?: string, dottedWord?: string, domain?: string, plainWord?: string, _possessive?: string, hyphen?: string) => {
        const word = dottedWord || plainWord;
        if (url || email || domain || !word) return m;
        const key = word.replace(/[ \t\u3000]+/g, ' ').toLowerCase();
        const e = chosen.get(key);
        if (!e) return m;
        onHit?.(key, e.reading);
        return hyphen ? `${e.reading} ` : e.reading;
      },
    );
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
        if (word.length < 2 || isSpelledAcronym(word)) continue;
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
