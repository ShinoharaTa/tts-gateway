import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toSpoken } from '../src/text/spoken.ts';

test('URL・メールアドレスを消す', () => {
  assert.equal(toSpoken('詳しくは https://example.com/a?b=1 を見て'), '詳しくは を見て');
  assert.equal(toSpoken('連絡は me@example.com まで'), '連絡は まで');
});

test('%・$・¥', () => {
  assert.equal(toSpoken('成長率 25%'), '成長率 25パーセント');
  assert.equal(toSpoken('$20 と $1.5億'), '20ドル と 1.5億ドル');
  assert.equal(toSpoken('¥1,000'), '1000円');
  assert.equal(toSpoken('$20/月'), '20ドル月あたり');
});

test('矢印・波線・日付・型番', () => {
  assert.equal(toSpoken('100→200'), '100から200');
  assert.equal(toSpoken('A → B'), 'A、B');
  assert.equal(toSpoken('10〜12月'), '10から12月');
  assert.equal(toSpoken('2026/10/27 に'), '2026年10月27日 に');
  assert.equal(toSpoken('GPT-5.5'), 'GPT 5.5');
});

test('中黒・トークン', () => {
  assert.equal(toSpoken('ジェフ・ベゾス'), 'ジェフベゾス');
  assert.equal(toSpoken('東京・大阪'), '東京、大阪');
  assert.equal(toSpoken('300tokens/s'), '300トークン毎秒');
});

test('文の数を変えない（改行・句点を残す）', () => {
  // NFKC で ！ は ! になる
  assert.equal(toSpoken('一文目。\n二文目！'), '一文目。\n二文目!');
});
