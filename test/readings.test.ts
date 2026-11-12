import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_DIR } from '../src/config.ts';
import { compileReadings, Dictionary, isAcronym, isReading, parseReadingsTsv, type ReadingRow } from '../src/text/readings.ts';
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
