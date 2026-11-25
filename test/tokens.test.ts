import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import { configureLog, setLogSink } from '../src/log.ts';
import { EXPIRED_KEEP_MS, TOKEN_RE, TokenStore } from '../src/tokens.ts';
import { tempDir } from './helpers.ts';

type Line = { level: string; msg: string; [k: string]: unknown };

/** json 形式のログを受ける */
const capture = (): Line[] => {
  const lines: Line[] = [];
  configureLog({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug' });
  setLogSink((_stream, line) => lines.push(JSON.parse(line) as Line));
  return lines;
};

afterEach(() => {
  setLogSink(null);
  configureLog({});
});

const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;

/** 時刻を差し替えたストア。t を進めて使う */
const setup = async () => {
  capture();
  const { dir, cleanup } = await tempDir();
  const clock = { t: T0 };
  const now = () => clock.t;
  const store = await TokenStore.load(dir, now);
  const file = async () => JSON.parse(await readFile(join(dir, 'api-tokens.json'), 'utf8')) as {
    version: number; tokens: { id: string; hash: string; lastUsedAt: string | null }[];
  };
  return { dir, cleanup, clock, now, store, file };
};

test('issue: 値の形、ファイルに値が無く hash は sha256、version 1', async () => {
  const s = await setup();
  try {
    const { view, token } = await s.store.issue('pixel', 3600);
    assert.match(token, TOKEN_RE);
    assert.equal(token.length, 62);
    assert.equal(token.slice(5, 13), view.id);
    assert.deepEqual(view, {
      id: view.id, label: 'pixel', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z', lastUsedAt: null, expired: false,
    });
    const text = await readFile(join(s.dir, 'api-tokens.json'), 'utf8');
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(token.slice(14)));
    const f = await s.file();
    assert.equal(f.version, 1);
    assert.equal(f.tokens[0]!.hash, createHash('sha256').update(token).digest('hex'));
  } finally {
    await s.cleanup();
  }
});

test('issue: ファイルの権限は 0600、.tmp が残らない', async () => {
  const s = await setup();
  try {
    await s.store.issue('a', 3600);
    await s.store.issue('b', 3600);
    assert.equal((await stat(s.store.path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(s.dir)).filter(n => n.endsWith('.tmp')), []);
  } finally {
    await s.cleanup();
  }
});

test('verify: 正しい値は id、違う値・無い id・形の違う値は null', async () => {
  const s = await setup();
  try {
    const { view, token } = await s.store.issue('a', 3600);
    assert.equal(s.store.verify(token), view.id);
    const last = token.at(-1) === '0' ? '1' : '0';
    assert.equal(s.store.verify(token.slice(0, -1) + last), null);
    const otherId = view.id === '00000000' ? '11111111' : '00000000';
    assert.equal(s.store.verify(`ttsg_${otherId}_${token.slice(14)}`), null);
    for (const bad of ['', 'ttsg_', token.toUpperCase(), `ttsg_${view.id}_${token.slice(14).toUpperCase()}`, ` ${token}`, `${token} `, `${token}0`, `x${token}`]) {
      assert.equal(s.store.verify(bad), null, JSON.stringify(bad));
    }
  } finally {
    await s.cleanup();
  }
});

test('期限: 1 ミリ秒前は通り、ちょうどで null。list の expired が切り替わる', async () => {
  const s = await setup();
  try {
    const { view, token } = await s.store.issue('a', 3600);
    s.clock.t = T0 + HOUR - 1;
    assert.equal(s.store.verify(token), view.id);
    assert.equal(s.store.list()[0]!.expired, false);
    s.clock.t = T0 + HOUR;
    assert.equal(s.store.verify(token), null);
    assert.equal(s.store.list()[0]!.expired, true);
  } finally {
    await s.cleanup();
  }
});

test('revoke: 以後 null、無い id は undefined、ファイルから消える', async () => {
  const s = await setup();
  try {
    const { view, token } = await s.store.issue('a', 3600);
    const other = await s.store.issue('b', 3600);
    const rec = await s.store.revoke(view.id);
    assert.equal(rec?.id, view.id);
    assert.equal(rec?.label, 'a');
    assert.equal(s.store.verify(token), null);
    assert.equal(await s.store.revoke(view.id), undefined);
    assert.equal(await s.store.revoke('zzz'), undefined);
    assert.deepEqual((await s.file()).tokens.map(t => t.id), [other.view.id]);
  } finally {
    await s.cleanup();
  }
});

test('lastUsedAt: verify 直後はメモリだけ、flush で書く。dirty でない flush は書かない', async () => {
  const s = await setup();
  try {
    const { token } = await s.store.issue('a', 3600);
    // dirty でない flush はファイルを書かない
    const m1 = (await stat(s.store.path)).mtimeMs;
    await new Promise(r => setTimeout(r, 20));
    await s.store.flush();
    assert.equal((await stat(s.store.path)).mtimeMs, m1);

    s.clock.t = T0 + 5000;
    s.store.verify(token);
    assert.equal(s.store.list()[0]!.lastUsedAt, '2026-01-01T00:00:05Z');
    assert.equal((await s.file()).tokens[0]!.lastUsedAt, null);
    await s.store.flush();
    assert.equal((await s.file()).tokens[0]!.lastUsedAt, '2026-01-01T00:00:05Z');
  } finally {
    await s.cleanup();
  }
});

test('永続化: load し直しても verify が通り、list が同じ', async () => {
  const s = await setup();
  try {
    const a = await s.store.issue('a', 3600);
    s.clock.t += 1000;
    await s.store.issue('b', 86400);
    s.store.verify(a.token);
    await s.store.flush();
    const again = await TokenStore.load(s.dir, s.now);
    assert.equal(again.verify(a.token), a.view.id);
    assert.deepEqual(again.list().map(v => v.label), ['b', 'a']);
    // load し直した側でも verify したので lastUsedAt だけは違う
    const strip = (store: TokenStore) => store.list().map(({ lastUsedAt: _l, ...v }) => v);
    assert.deepEqual(strip(again), strip(s.store));
    assert.equal(s.store.list().length, 2);
  } finally {
    await s.cleanup();
  }
});

test('掃除: 期限 + 7 日の直前は残り、過ぎると tick で消えてファイルからも消える。load 時の掃除は書かない', async () => {
  const s = await setup();
  try {
    await s.store.issue('a', 3600);
    s.clock.t = T0 + HOUR + EXPIRED_KEEP_MS - 1;
    await s.store.tick();
    assert.equal(s.store.list().length, 1);
    assert.equal((await s.file()).tokens.length, 1);
    // load 時の掃除はメモリだけ
    s.clock.t = T0 + HOUR + EXPIRED_KEEP_MS;
    const again = await TokenStore.load(s.dir, s.now);
    assert.equal(again.list().length, 0);
    assert.equal((await s.file()).tokens.length, 1);
    await s.store.tick();
    assert.equal(s.store.list().length, 0);
    assert.equal((await s.file()).tokens.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('上限: 有効 20 件で 21 件目は 400、失効すれば発行できる、期限切れは数えない、総数 50 で期限切れの古い順に消える', async () => {
  const s = await setup();
  try {
    const first: string[] = [];
    for (let i = 0; i < 20; i++) first.push((await s.store.issue(`a${i}`, 3600)).view.id);
    await assert.rejects(s.store.issue('x', 3600), (e: unknown) => e instanceof ApiError && e.status === 400 && e.message === 'too many active tokens (up to 20)');
    await s.store.revoke(first[0]!);
    await s.store.issue('x', 3600);
    // 期限切れは数えない
    s.clock.t = T0 + HOUR;
    for (let i = 0; i < 20; i++) await s.store.issue(`b${i}`, 3600);
    s.clock.t = T0 + 2 * HOUR;
    for (let i = 0; i < 10; i++) await s.store.issue(`c${i}`, 3600);
    assert.equal(s.store.list().length, 50);
    // 総数 50: 期限切れのうち expiresAt の古いもの（a* と x）から消える
    await s.store.issue('d', 3600);
    const labels = s.store.list().map(v => v.label);
    assert.equal(labels.length, 50);
    assert.ok(labels.includes('d'));
    assert.equal(labels.filter(l => /^(a\d+|x)$/.test(l)).length, 19);
    assert.equal(labels.filter(l => l.startsWith('b')).length, 20);
  } finally {
    await s.cleanup();
  }
});

test('壊れたファイル: 空で始め、.broken に退避し、error を 1 行。その後の issue で正しく書く', async () => {
  const cases: [string, string][] = [
    ['not json', '{bad'],
    ['version 2', JSON.stringify({ version: 2, tokens: [] })],
    ['hash', JSON.stringify({ version: 1, tokens: [{ id: 'aaaaaaaa', label: 'a', hash: 'ab', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', lastUsedAt: null }] })],
    ['dup id', JSON.stringify({ version: 1, tokens: [0, 1].map(() => ({ id: 'aaaaaaaa', label: 'a', hash: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', lastUsedAt: null })) })],
  ];
  for (const [name, body] of cases) {
    const lines = capture();
    const { dir, cleanup } = await tempDir();
    try {
      const path = join(dir, 'api-tokens.json');
      await writeFile(path, body);
      const store = await TokenStore.load(dir, () => T0);
      assert.deepEqual(store.list(), [], name);
      assert.equal(await readFile(`${path}.broken`, 'utf8'), body, name);
      const errors = lines.filter(l => l.level === 'error');
      assert.equal(errors.length, 1, name);
      assert.equal(errors[0]!.msg, 'api-tokens.json is unreadable; starting with no API tokens');
      const { token } = await store.issue('a', 3600);
      const f = JSON.parse(await readFile(path, 'utf8')) as { version: number; tokens: unknown[] };
      assert.equal(f.version, 1, name);
      assert.equal(f.tokens.length, 1, name);
      assert.ok((await TokenStore.load(dir, () => T0)).verify(token), name);
    } finally {
      await cleanup();
    }
  }
});

test('書き込み失敗: issue は reject して残らない、revoke は reject しても失効したまま、tick は reject せず warn は 1 行', async () => {
  const s = await setup();
  const lines = capture();
  try {
    const { view, token } = await s.store.issue('a', 3600);
    // api-tokens.json の位置をディレクトリにして rename を失敗させる
    await rm(s.store.path);
    await mkdir(s.store.path);
    await assert.rejects(s.store.issue('b', 3600));
    assert.deepEqual(s.store.list().map(v => v.label), ['a']);
    await assert.rejects(s.store.revoke(view.id));
    assert.equal(s.store.verify(token), null);
    assert.deepEqual(s.store.list(), []);
    await s.store.tick();
    await s.store.tick();
    await s.store.tick();
    assert.equal(lines.filter(l => l.level === 'warn' && l.msg === 'cannot write api-tokens.json').length, 1);
    // 書けるようになれば次の tick で書く
    await rm(s.store.path, { recursive: true });
    await s.store.tick();
    assert.ok(existsSync(s.store.path));
    assert.deepEqual(JSON.parse(await readFile(s.store.path, 'utf8')).tokens, []);
  } finally {
    await s.cleanup();
  }
});
