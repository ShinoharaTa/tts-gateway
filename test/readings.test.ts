import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_DIR } from '../src/config.ts';
import { compileReadings, Dictionary, DOMAIN_RE, isAcronym, isReading, parseReadingsTsv, type ReadingRow, type Readings } from '../src/text/readings.ts';
import { EMAIL_RE, URL_RE } from '../src/text/spoken.ts';
import { tempDir } from './helpers.ts';

const rows = (pairs: [string, string][], source: ReadingRow['source'] = 'builtin'): ReadingRow[] =>
  pairs.map(([surface, reading]) => ({ surface, reading, source }));

test('parseReadingsTsv: コメント・空行・不正な読みを飛ばし、NFKC と空白をそろえる', () => {
  const tsv = '# comment\n\nGitHub\tギットハブ\nBad\tbad\n  Ｈｕｇｇｉｎｇ   Face \tハギングフェイス\r\nNoTab\n';
  assert.deepEqual(parseReadingsTsv(tsv), [
    { surface: 'GitHub', reading: 'ギットハブ', source: 'builtin' },
    { surface: 'Hugging Face', reading: 'ハギングフェイス', source: 'builtin' },
  ]);
});

test('組み込みの dict/readings.tsv が読めて、足した語が入っている', () => {
  const builtin = parseReadingsTsv(readFileSync(join(PACKAGE_DIR, 'dict', 'readings.tsv'), 'utf8'));
  const r = compileReadings(builtin);
  assert.equal(r.apply('GitHub に Claude のコードを push しました。'), 'ギットハブ に クロード のコードを プッシュ しました。');
  assert.equal(r.apply('ZEN-TTS と VOICEVOX'), 'ゼンティーティーエス と ボイスボックス');
  const keys = builtin.map(x => x.surface.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, '重複が無い');
});

test('大文字小文字を同一視し、長い語を先に当てる', () => {
  const r = compileReadings(rows([['MacBook', 'マックブック'], ['MacBook Pro', 'マックブックプロ'], ['Hugging', 'ハギング'], ['Hugging Face', 'ハギングフェイス']]));
  assert.equal(r.apply('macbook pro と MACBOOK'), 'マックブックプロ と マックブック');
  assert.equal(r.apply('Hugging  Face'), 'ハギングフェイス');
});

test('語の境界: 前が英数字でない・後ろが英字でない', () => {
  const r = compileReadings(rows([['iPhone', 'アイフォーン'], ['Mac', 'マック']]));
  assert.equal(r.apply('iPhone16'), 'アイフォーン16');
  assert.equal(r.apply('xiPhone'), 'xiPhone');
  assert.equal(r.apply('Macro'), 'Macro');
  assert.equal(r.apply('2Mac'), '2Mac');
  assert.equal(r.apply('「Mac」'), '「マック」');
});

test('登録した語は全部大文字でも置き換える。未知語からは全部大文字 3 字以内だけ除く', () => {
  assert.equal(isAcronym('API'), true);
  assert.equal(isAcronym('PS5'), true);
  assert.equal(isAcronym('VOICEVOX'), false);
  assert.equal(isAcronym('Api'), false);
  const r = compileReadings(rows([['Max', 'マックス'], ['GPU', 'ジーピーユー'], ['NASA', 'ナサ']]));
  assert.equal(r.apply('MAX と Max'), 'マックス と マックス');
  assert.equal(r.apply('GPU と NASA'), 'ジーピーユー と ナサ');
  assert.equal(r.size, 3);
  // 登録なし: 4 字以上の大文字語は未知語、3 字以内は出さない
  const empty = compileReadings([]);
  assert.equal(empty.apply('NASA'), 'NASA');
  assert.deepEqual(empty.unknownWords(['NASA と JSON と API と GPU']), [
    { word: 'JSON', count: 1 },
    { word: 'NASA', count: 1 },
  ]);
  assert.deepEqual(r.unknownWords(['NASA と API']), [], '登録した NASA は未知語に出ない');
});

test('URL・メールアドレス・ドメインの中は置き換えない', () => {
  const r = compileReadings(rows([['GitHub', 'ギットハブ'], ['example', 'エグザンプル']]));
  assert.equal(r.apply('https://github.com/example を見る'), 'https://github.com/example を見る');
  assert.equal(r.apply('github.com/foo と GitHub'), 'github.com/foo と ギットハブ');
  assert.equal(r.apply('me@example.com に example'), 'me@example.com に エグザンプル');
});

test('ドットを含む surface はドメインの形でも当てる。辞書に無いドメインの中は置き換えない', () => {
  const r = compileReadings(
    rows([['Character.AI', 'キャラクターエーアイ'], ['Booking.com', 'ブッキングドットコム'], ['Node.js', 'ノードジェイエス'], ['example', 'エグザンプル'], ['Character', 'キャラクター']]),
  );
  assert.equal(r.apply('Character.AI と Booking.com と Node.js'), 'キャラクターエーアイ と ブッキングドットコム と ノードジェイエス');
  assert.equal(r.apply('example.com と www.booking.com と character.ai.example.com'), 'example.com と www.booking.com と character.ai.example.com');
  assert.equal(r.apply('example と Character'), 'エグザンプル と キャラクター');
  assert.deepEqual(r.hits(['Booking.com']), [{ surface: 'booking.com', reading: 'ブッキングドットコム' }]);
});

test('語の間の空白は改行をまたがない', () => {
  const r = compileReadings(rows([['MacBook Pro', 'マックブックプロ'], ['Hugging Face', 'ハギングフェイス']]));
  assert.equal(r.apply('MacBook\nPro'), 'MacBook\nPro');
  assert.equal(r.apply('MacBook \r\n Pro'), 'MacBook \r\n Pro');
  assert.equal(r.apply('MacBook\tPro と Hugging　Face'), 'マックブックプロ と ハギングフェイス');
});

test('記号や数字を含む surface（GPT-4o・COVID-19）', () => {
  const r = compileReadings(rows([['GPT-4o', 'ジーピーティーフォーオー'], ['COVID-19', 'コビッドナインティーン']]));
  assert.equal(r.apply('GPT-4o と COVID-19'), 'ジーピーティーフォーオー と コビッドナインティーン');
  assert.equal(r.apply('GPT-4omni と COVID-190'), 'GPT-4omni と COVID-190');
});

test('読みは全角カタカナ・ー・・・空白だけ（半角カナは不可）', () => {
  assert.equal(isReading('アイフォーン'), true);
  assert.equal(isReading('ジェフ・ベゾス ニ'), true);
  assert.equal(isReading('ｱｲｳ'), false);
  assert.equal(isReading('アイｳ'), false);
  assert.equal(isReading('ー・'), false);
  assert.deepEqual(parseReadingsTsv('Foo\tｱｲｳ\nBar\tバー\n'), [{ surface: 'Bar', reading: 'バー', source: 'builtin' }]);
});

test("所有格 's は消し、-数字・-英字のハイフンは空白にする", () => {
  const r = compileReadings(rows([['Apple', 'アップル'], ['Pixel', 'ピクセル'], ['Mac', 'マック']]));
  assert.equal(r.apply("Apple's 新製品"), 'アップル 新製品');
  assert.equal(r.apply('Pixel-9'), 'ピクセル 9');
  assert.equal(r.apply('Mac-mini'), 'マック mini');
});

test('ユーザー辞書が組み込みを上書きし、要求ごとの readings がさらに上書きする', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const builtinPath = join(dir, 'builtin.tsv');
    const userPath = join(dir, 'user', 'readings.tsv');
    await import('node:fs/promises').then(fs => fs.writeFile(builtinPath, 'Claude\tクロード\nRust\tラスト\n'));
    const dict = await Dictionary.load(builtinPath, userPath);
    assert.equal(dict.readings.apply('Claude'), 'クロード');
    await dict.set('claude', 'クラウド');
    assert.equal(dict.readings.apply('Claude'), 'クラウド');
    const json = dict.toJSON();
    assert.deepEqual(
      json.entries.find(e => e.surface.toLowerCase() === 'claude'),
      { surface: 'claude', reading: 'クラウド', source: 'user' },
    );
    assert.match(await readFile(userPath, 'utf8'), /^claude\tクラウド$/m);
    // 要求ごと
    const req = dict.withRequest({ Claude: 'クロオド', Foo: 'フー' });
    assert.equal(req.apply('Claude と Foo と Rust'), 'クロオド と フー と ラスト');
    assert.equal(dict.readings.apply('Foo'), 'Foo', '辞書そのものは変わらない');
    // 削除でユーザーの分が消え、組み込みに戻る
    assert.equal(await dict.delete('CLAUDE'), true);
    assert.equal(await dict.delete('Rust'), false, '組み込みの語は消せない');
    assert.equal(dict.readings.apply('Claude'), 'クロード');
    // 読み直しても同じ
    const again = await Dictionary.load(builtinPath, userPath);
    assert.equal(again.readings.apply('Claude'), 'クロード');
  } finally {
    await cleanup();
  }
});

test('hits と unknownWords', () => {
  const r = compileReadings(rows([['GitHub', 'ギットハブ'], ['push', 'プッシュ']]));
  assert.deepEqual(r.hits(['GitHub に push、また GitHub']), [
    { surface: 'github', reading: 'ギットハブ' },
    { surface: 'push', reading: 'プッシュ' },
  ]);
  assert.deepEqual(r.unknownWords(["Foo と foo と Bar's と API と x と example.com と GitHub"]), [
    { word: 'Foo', count: 2 },
    { word: 'Bar', count: 1 },
  ]);
});

test('辞書の version は読みが同じなら同じ', () => {
  const a = compileReadings(rows([['A1x', 'エー'], ['Bee', 'ビー']]));
  const b = compileReadings(rows([['bee', 'ビー'], ['a1x', 'エー']]));
  assert.equal(a.version, b.version);
  const c = compileReadings(rows([['Bee', 'ビイ']]));
  assert.notEqual(a.version, c.version);
});

test('要求ごとの readings 200 語 × 本文 2,000 字が 200ms 以内', () => {
  const builtin = parseReadingsTsv(readFileSync(join(PACKAGE_DIR, 'dict', 'readings.tsv'), 'utf8'));
  const dict = new Dictionary(builtin, [], '/nonexistent/readings.tsv');
  const tag = (i: number): string => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));
  // 変更前は数秒かかった形: 100 字の surface が本文の語の並びと途中まで一致する
  const spaced = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${'a '.repeat(48)}${tag(i)}`, 'ア']));
  const plain = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`word${tag(i)}`, 'ワード']));
  const plainText = Object.keys(plain).map(w => `${w} を GitHub に push した。`).join('').slice(0, 2000);
  for (const [readings, text] of [[spaced, 'a '.repeat(1000)], [plain, plainText]] as const) {
    const started = performance.now();
    const r = dict.withRequest(readings);
    r.apply(text);
    r.hits([text]);
    r.unknownWords([text]);
    const ms = performance.now() - started;
    assert.ok(ms < 200, `${ms.toFixed(0)}ms`);
  }
});

// ---- 照合の結果を、正規表現 1 本で照合していた実装（変更前）と比べる ----

/**
 * 変更前の照合（URL・メール・ドットを含む surface・ドメイン・ほかの surface を 1 本の正規表現で当てる。
 * 全部大文字の語も置き換え、語の間の空白は改行をまたがない）。r.entries() の語で作る
 */
const legacyReplace = (r: Readings, text: string): { out: string; hits: string[] } => {
  const entries = r.entries();
  const chosen = new Map(entries.map(e => [e.surface.toLowerCase(), e.reading]));
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const surfacePattern = (surface: string): string => {
    const body = surface.split(' ').map(escapeRe).join('[ \\t\\u3000]+');
    const head = /[A-Za-z0-9]/.test(surface[0]!) ? '(?<![A-Za-z0-9])' : '';
    const last = surface.at(-1)!;
    const tail = /[A-Za-z]/.test(last) ? '(?![A-Za-z])' : /\d/.test(last) ? '(?![A-Za-z0-9])' : '';
    return `${head}${body}${tail}`;
  };
  const byLength = entries.map(e => e.surface).sort((a, b) => b.length - a.length);
  const nfkc = text.normalize('NFKC');
  const hits: string[] = [];
  if (!byLength.length) return { out: nfkc, hits };
  const dotted = byLength.filter(s => s.includes('.'));
  const plain = byLength.filter(s => !s.includes('.'));
  const group = (list: string[]): string => (list.length ? list.map(surfacePattern).join('|') : '(?!)');
  const dottedGroup = dotted.length ? `(?<![.@])(?:${group(dotted)})(?!\\.[A-Za-z0-9])` : '(?!)';
  const re = new RegExp(
    `(${URL_RE.source})|(${EMAIL_RE.source})|(${dottedGroup})|(${DOMAIN_RE.source})|(${group(plain)})` +
      `(?:(['’]s(?![A-Za-z]))|(-(?=[A-Za-z0-9])))?`,
    'giu',
  );
  const out = nfkc.replace(
    re,
    (m: string, url?: string, email?: string, dottedWord?: string, domain?: string, plainWord?: string, _p?: string, hyphen?: string) => {
      const word = dottedWord || plainWord;
      if (url || email || domain || !word) return m;
      const key = word.replace(/[ \t\u3000]+/g, ' ').toLowerCase();
      const reading = chosen.get(key);
      if (!reading) return m;
      hits.push(key);
      return hyphen ? `${reading} ` : reading;
    },
  );
  return { out, hits };
};

/** 決まった種から作る乱数（テストを毎回同じにする） */
const prng = (seed: number): (() => number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};

const assertSameAsLegacy = (r: Readings, text: string, label: string): void => {
  const want = legacyReplace(r, text);
  assert.equal(r.apply(text), want.out, label);
  assert.deepEqual(r.hits([text]).map(h => h.surface), [...new Set(want.hits)], label);
};

test('照合の結果が変更前の実装と同じ（固定の例）', () => {
  const r = compileReadings(rows([
    ['GitHub', 'ギットハブ'], ['push', 'プッシュ'], ['MacBook', 'マックブック'], ['MacBook Pro', 'マックブックプロ'],
    ['Mac', 'マック'], ['iPhone', 'アイフォーン'], ['Apple', 'アップル'], ['Pixel', 'ピクセル'], ['example', 'エグザンプル'],
    ['Next.js', 'ネクストジェイエス'], ['C++', 'シープラスプラス'], ['A1', 'エーワン'], ['Ver2', 'バーツー'], ['Pokémon', 'ポケモン'],
    ['Σίσυφος', 'シシュフォス'], ['ς', 'シグマ'], ['café', 'カフェ'], ['Foo', 'フー'], ['Foo Bar', 'フーバー'], ['日本語', 'ニホンゴ'],
    ['.NET', 'ドットネット'], ['Mac-mini', 'マックミニ'], ['GPU', 'ジーピーユー'], ['Max', 'マックス'],
    ['Character.AI', 'キャラクターエーアイ'], ['Character', 'キャラクター'], ['Booking.com', 'ブッキングドットコム'], ['NASA', 'ナサ'],
    ['API', 'エーピーアイ'], ['PS5', 'ピーエスファイブ'], ['Hugging Face', 'ハギングフェイス'],
  ]));
  const texts = [
    'GitHub に push、macbook pro と MACBOOK と Mac-mini',
    "Apple's Pixel-9 と Pixel-a と iPhone16 と xiPhone と 2Mac",
    'https://github.com/example と github.com/foo と me@example.com と example.com-x',
    'Next.js と C++ と c++17 と A1x と a1 と VER2 と ver23',
    'POKÉMON と pokémon と ΣΊΣΥΦΟΣ と σίσυφοσ と Σ と σ と CAFÉ',
    'foo  bar と foo　bar と foo\tbar と Foo\nBar と foobar',
    '日本語と.NET と .net と ASP.NET と MAX と Max と GPU',
    "HTTPS://GITHUB.COM/x と Foo's と Foo’s と Foo'sx と Foo-",
    'Character.AI と CHARACTER.AI と character.ai.example.com と x.character.ai と @character.ai と Character.AI.',
    "Booking.com と www.booking.com と booking.com/a と Booking.com's と Character.AI-9 と example.com",
    'NASA と API と GPU と PS5 と Api と nasa と APIs',
    'MacBook\nPro と MacBook \r\n Pro と Hugging\nFace と Hugging　Face と Hugging\tFace と Foo \n Bar',
  ];
  for (const text of texts) assertSameAsLegacy(r, text, text);
});

test('照合の結果が変更前の実装と同じ（乱数の例）', () => {
  const rand = prng(19);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const surfaceChars = ['a', 'b', 'A', 'B', 'k', 's', '1', '2', ' ', '-', '.', "'", '+', 'é', 'É', 'σ', 'ς', 'Σ', 'ア', '日'];
  const textChars = [...surfaceChars, '　', '\t', '  ', '\n', '@', '/', '’', 'x', 'K', 'ſ', '😀', 'ｂ', '\uD800'];
  const textParts = [
    'https://ab.com/a', 'a@b.com', 'ab.com', 'ab.io/x', "'s", '-1', '-a', 'AB', 'ABA', 'KAB',
    'a\nb', 'ab\nab', 'a \n b', 'A\r\nB', 'x.ab.com', 'ab.ai.b.com', 'ab.com.', '.ab.com', '@ab.com', 'a.b.io', 'AB.AI', 'b.ab.co/a',
  ];
  // #28 の規則が効く形の surface（ドットを含む・全部大文字・空白を含む・ドメインの形）
  const surfaceParts = ['ab.com', 'a.b', 'A.I', 'ab.ai', '.ab', 'AB', 'ABA', 'AB1', 'K', 'a b', 'ab', 'b.io'];
  for (let round = 0; round < 80; round++) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < 12; i++) {
      let s = '';
      if (rand() < 0.3) s = pick(surfaceParts);
      else {
        const len = 1 + Math.floor(rand() * 5);
        for (let j = 0; j < len; j++) s += pick(surfaceChars);
      }
      if (rand() < 0.2) s = s.toUpperCase();
      pairs.push([s, pick(['ア', 'イー', 'ウ ウ'])]);
    }
    const r = compileReadings(rows(pairs, pick(['builtin', 'user', 'request'] as const)));
    for (let t = 0; t < 25; t++) {
      let text = '';
      const len = Math.floor(rand() * 40);
      for (let j = 0; j < len; j++) text += rand() < 0.15 ? pick(textParts) : rand() < 0.3 ? pick(pairs)[0] : pick(textChars);
      assertSameAsLegacy(r, text, JSON.stringify({ pairs, text }));
    }
  }
});

test('照合の結果が変更前の実装と同じ（組み込みの辞書）', () => {
  const r = compileReadings(parseReadingsTsv(readFileSync(join(PACKAGE_DIR, 'dict', 'readings.tsv'), 'utf8')));
  const words = r.entries().map(e => e.surface);
  const rand = prng(7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const glue = [' ', '、', 'と', "'s ", '-9 ', '-a ', 'x', '1', '. ', ' https://github.com/a ', ' a@b.jp ', ' foo.dev ', '　', '\n', ' \n ', '.com ', '.ai ', '.example.com '];
  for (let t = 0; t < 200; t++) {
    let text = '';
    const len = Math.floor(rand() * 30);
    for (let j = 0; j < len; j++) {
      const w = pick(words);
      text += (rand() < 0.3 ? w.toUpperCase() : rand() < 0.3 ? w.toLowerCase() : w) + pick(glue);
    }
    assertSameAsLegacy(r, text, text);
  }
});
