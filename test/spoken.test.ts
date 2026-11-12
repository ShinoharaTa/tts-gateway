import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterReadings, beforeReadings, toSpoken } from '../src/text/spoken.ts';

test('URL・メールアドレスを消す', () => {
  assert.equal(toSpoken('詳しくは https://example.com/a?b=1 を見て'), '詳しくは を見て');
  assert.equal(toSpoken('連絡は me@example.com まで'), '連絡は まで');
});

test('URL の削除は ASCII の URL 文字だけ。末尾の句読点は残す', () => {
  // NFKC で ！？ は !? になる
  assert.equal(toSpoken('https://example.com/a！すごい？'), '!すごい?');
  assert.equal(toSpoken('見て https://example.com/a。次'), '見て 。次');
  assert.equal(toSpoken('(https://example.com/a?b=1), と https://example.com.'), '(), と .');
  assert.equal(toSpoken('https://example.com/a!b'), '');
});

test('beforeReadings は URL・メール・中黒だけ。記号の規則は afterReadings', () => {
  assert.equal(beforeReadings('GPT-4o を https://example.com で 25%・$20'), 'GPT-4o を  で 25%、$20');
  assert.equal(afterReadings('GPT 4o を 25%、$20'), 'GPT 4o を 25パーセント、20ドル');
  // 辞書の読みのカタカナ・中黒・長音は後段で変わらない
  assert.equal(afterReadings('ジェフ・ベゾス ハギング・フェイス'), 'ジェフ・ベゾス ハギング・フェイス');
});

test('空白の規則は改行をまたがない', () => {
  assert.equal(toSpoken('100\n→200'), '100\n、200');
  assert.equal(toSpoken('A\n→\nB'), 'A\n、\nB');
  assert.equal(toSpoken('25\n%'), '25\n%');
  assert.equal(toSpoken('300\ntokens'), '300\ntokens');
  assert.equal(toSpoken('$\n20'), '$\n20');
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
