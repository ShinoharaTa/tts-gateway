import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createApp, createHandler, type App } from '../src/server.ts';
import { FakeEngine, installedModel, tempDir } from './helpers.ts';

type Ctx = { base: string; app: App; engine: FakeEngine; stop: () => Promise<void> };

/** 偽のエンジンで起動する。env は loadConfig に渡す */
const start = async (env: Record<string, string> = {}): Promise<Ctx> => {
  const { dir, cleanup } = await tempDir();
  const config = loadConfig({ TTS_DATA_DIR: join(dir, 'data'), TTS_CACHE_DIR: join(dir, 'cache'), FFMPEG: 'false', ...env });
  const engine = new FakeEngine();
  const app = await createApp(config, {
    engines: deps => {
      engine.registry = deps.registry;
      engine.settings = deps.settings;
      return new Map([[engine.id, engine]]);
    },
    isHostAllowed: h => h === '127.0.0.1',
    protocols: ['http:'],
  });
  await app.registry.add(installedModel('zen-tts', 'marine'));
  const server = createServer(createHandler(app));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, app, engine,
    stop: async () => {
      await new Promise<void>(r => server.close(() => r()));
      await app.close();
      await cleanup();
    },
  };
};

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const errorCode = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

test('healthz・engines・404', async () => {
  const c = await start();
  try {
    const h = await fetch(`${c.base}/healthz`);
    assert.deepEqual(await h.json(), { status: 'ok', version: '0.1.0' });
    assert.equal(h.headers.get('access-control-allow-origin'), null);
    const e = (await (await fetch(`${c.base}/v1/engines`)).json()) as { default: unknown; engines: { id: string; voices: unknown[]; credit: unknown }[] };
    assert.deepEqual(e.default, { engine: 'zen-tts', voice: 'marine' });
    assert.equal(e.engines[0]!.id, 'zen-tts');
    assert.deepEqual(e.engines[0]!.voices, [{ id: 'marine', name: 'marine', installed: true, default: true }]);
    const nf = await fetch(`${c.base}/v1/nope`);
    assert.equal(nf.status, 404);
    assert.equal(await errorCode(nf), 'not_found');
    assert.equal((await fetch(`${c.base}/v1/engines`, { method: 'DELETE' })).status, 404);
  } finally {
    await c.stop();
  }
});

test('synthesize: 音声とヘッダ、2 回目は X-Cache: hit', async () => {
  const c = await start();
  try {
    const body = { text: 'GitHub に push しました。', leadingSilenceMs: 100 };
    const r1 = await fetch(`${c.base}/v1/synthesize`, json(body));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('content-type'), 'audio/wav');
    assert.equal(r1.headers.get('x-engine'), 'zen-tts');
    assert.equal(r1.headers.get('x-voice'), 'marine');
    assert.equal(r1.headers.get('x-sample-rate'), '8000');
    assert.equal(r1.headers.get('x-cache'), 'miss');
    assert.match(r1.headers.get('x-synthesis-ms')!, /^\d+$/);
    assert.match(r1.headers.get('x-audio-duration-ms')!, /^\d+$/);
    assert.equal(decodeURIComponent(r1.headers.get('x-tts-credit')!), c.engine.credit.en);
    assert.match(r1.headers.get('etag')!, /^"[0-9a-f]{64}"$/);
    const audio = Buffer.from(await r1.arrayBuffer());
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(c.engine.calls[0]!.sentence, 'ギットハブ に プッシュ しました。');
    const r2 = await fetch(`${c.base}/v1/synthesize`, json(body));
    assert.equal(r2.headers.get('x-cache'), 'hit');
    assert.equal(r2.headers.get('x-synthesis-ms'), '0');
    assert.equal(r2.headers.get('etag'), r1.headers.get('etag'));
    assert.deepEqual(Buffer.from(await r2.arrayBuffer()), audio);
    const st = (await (await fetch(`${c.base}/v1/admin/status`)).json()) as { cache: { entries: number } };
    assert.equal(st.cache.entries, 1);
    assert.equal((await fetch(`${c.base}/v1/admin/cache`, { method: 'DELETE' })).status, 204);
    const r3 = await fetch(`${c.base}/v1/synthesize`, json(body));
    assert.equal(r3.headers.get('x-cache'), 'miss');
  } finally {
    await c.stop();
  }
});

test('synthesize: 400・404・413・415・422', async () => {
  const c = await start({ TTS_MAX_CHARS: '10' });
  try {
    const post = (body: unknown) => fetch(`${c.base}/v1/synthesize`, json(body));
    let r = await post({ text: 'a', speeed: 1 });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: { code: 'invalid_request', message: 'unknown field speeed', field: 'speeed' } });
    r = await post({ text: 'a', zenTts: { speed: 9 } });
    assert.equal(r.status, 400);
    r = await post({ text: 'あ'.repeat(11) });
    assert.equal(r.status, 413);
    assert.equal(await errorCode(r), 'text_too_long');
    r = await post({ text: 'a', voice: 'nope' });
    assert.equal(r.status, 404);
    await c.app.registry.add({ ...installedModel('zen-tts', 'kikka'), status: 'pending' });
    r = await post({ text: 'a', voice: 'kikka' });
    assert.equal(r.status, 422);
    assert.equal(await errorCode(r), 'model_not_installed');
    r = await fetch(`${c.base}/v1/synthesize`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"text":"a"}' });
    assert.equal(r.status, 415);
    assert.equal(await errorCode(r), 'unsupported_media_type');
    r = await fetch(`${c.base}/v1/synthesize`, { method: 'POST', body: new URLSearchParams({ text: 'a' }) });
    assert.equal(r.status, 415);
    r = await fetch(`${c.base}/v1/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{bad' });
    assert.equal(r.status, 400);
  } finally {
    await c.stop();
  }
});

test('normalize と辞書', async () => {
  const c = await start();
  try {
    let r = await fetch(`${c.base}/v1/normalize`, json({ text: 'Foo を GitHub に push' }));
    const n = (await r.json()) as { spoken: string; unknownWords: unknown };
    assert.equal(n.spoken, 'Foo を ギットハブ に プッシュ');
    assert.deepEqual(n.unknownWords, [{ word: 'Foo', count: 1 }]);
    r = await fetch(`${c.base}/v1/admin/dictionary/${encodeURIComponent('Foo')}`, { ...json({ reading: 'フー' }), method: 'PUT' });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { version: string; entries: { surface: string; source: string }[] };
    assert.deepEqual(d.entries.find(e => e.surface === 'Foo'), { surface: 'Foo', reading: 'フー', source: 'user' });
    r = await fetch(`${c.base}/v1/normalize`, json({ text: 'Foo を GitHub に push' }));
    assert.equal(((await r.json()) as { spoken: string }).spoken, 'フー を ギットハブ に プッシュ');
    // 組み込みの語を上書き
    r = await fetch(`${c.base}/v1/admin/dictionary/GitHub`, { ...json({ reading: 'ギッハブ' }), method: 'PUT' });
    assert.equal(r.status, 200);
    const all = (await (await fetch(`${c.base}/v1/dictionary`)).json()) as { entries: { surface: string; reading: string; source: string }[] };
    assert.deepEqual(all.entries.find(e => e.surface === 'GitHub'), { surface: 'GitHub', reading: 'ギッハブ', source: 'user' });
    // 読みの形・頭字語・未知のフィールド
    for (const [surface, body] of [['Bar', { reading: 'ばー' }], ['API', { reading: 'エーピーアイ' }], ['Bar', { reading: 'バー', x: 1 }]] as const) {
      r = await fetch(`${c.base}/v1/admin/dictionary/${surface}`, { ...json(body), method: 'PUT' });
      assert.equal(r.status, 400, surface);
    }
    // 削除: ユーザーの語だけ
    r = await fetch(`${c.base}/v1/admin/dictionary/GitHub`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    r = await fetch(`${c.base}/v1/admin/dictionary/GitHub`, { method: 'DELETE' });
    assert.equal(r.status, 404);
    r = await fetch(`${c.base}/v1/admin/dictionary/Claude`, { method: 'DELETE' });
    assert.equal(r.status, 404);
  } finally {
    await c.stop();
  }
});

test('入力の上限: surface・読みは 100 字、辞書の適用後は TTS_MAX_CHARS × 3 字まで', async () => {
  const c = await start();
  try {
    const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string; field?: string } }).error;
    // 長い読みと文分割で止まっていた入力（読み 1,000 字 × 666 回）。すぐに 400 で返る
    let started = performance.now();
    let r = await fetch(`${c.base}/v1/synthesize`, json({ text: 'zz '.repeat(666), readings: { zz: 'ア'.repeat(1000) } }));
    assert.equal(r.status, 400);
    assert.equal((await errorOf(r)).field, 'readings.zz');
    assert.ok(performance.now() - started < 1000, 'synthesize');
    // 上限内の読みでも、辞書の適用後に長くなりすぎたら 413（synthesize・normalize とも）
    for (const path of ['/v1/synthesize', '/v1/normalize']) {
      started = performance.now();
      r = await fetch(`${c.base}${path}`, json({ text: 'zz '.repeat(666), readings: { zz: 'ア'.repeat(100) } }));
      assert.equal(r.status, 413, path);
      const e = await errorOf(r);
      assert.equal(e.code, 'text_too_long');
      assert.match(e.message, /after applying/);
      assert.ok(performance.now() - started < 1000, path);
    }
    assert.equal(c.engine.calls.length, 0);
    // 上限（2,000 × 3 = 6,000 字）以内なら通る。(8 + 1) × 666 = 5,994 字ほど
    r = await fetch(`${c.base}/v1/normalize`, json({ text: 'zz '.repeat(666), readings: { zz: 'ア'.repeat(8) } }));
    assert.equal(r.status, 200);
    const spokenChars = [...((await r.json()) as { spoken: string }).spoken].length;
    assert.ok(spokenChars > 5900 && spokenChars <= 6000, String(spokenChars));
    // 辞書 API: surface・読みとも 100 字まで
    const put = (surface: string, reading: string) =>
      fetch(`${c.base}/v1/admin/dictionary/${encodeURIComponent(surface)}`, { ...json({ reading }), method: 'PUT' });
    assert.equal((await put('a'.repeat(100), 'ア'.repeat(100))).status, 200);
    r = await put('Foo', 'ア'.repeat(101));
    assert.equal(r.status, 400);
    assert.equal((await errorOf(r)).field, 'reading');
    r = await put('Foo', 'ア'.repeat(50_000));
    assert.equal(r.status, 400);
    assert.equal((await errorOf(r)).field, 'reading');
    r = await put('a'.repeat(101), 'ア');
    assert.equal(r.status, 400);
    assert.equal((await errorOf(r)).field, 'surface');
  } finally {
    await c.stop();
  }
});

test('認証: TTS_TOKEN と TTS_ADMIN_TOKEN', async () => {
  const c = await start({ TTS_TOKEN: 'user-token', TTS_ADMIN_TOKEN: 'admin-token' });
  try {
    const get = (path: string, token?: string) => fetch(`${c.base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal((await get('/healthz')).status, 200);
    const r = await get('/v1/engines');
    assert.equal(r.status, 401);
    assert.equal(await errorCode(r), 'unauthorized');
    assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await get('/v1/engines', 'wrong')).status, 401);
    assert.equal((await get('/v1/engines', 'user-token')).status, 200);
    assert.equal((await get('/v1/engines', 'admin-token')).status, 401);
    assert.equal((await get('/v1/admin/status', 'user-token')).status, 401);
    assert.equal((await get('/v1/admin/status', 'admin-token')).status, 200);
    // 認証は 415 より先
    const p = await fetch(`${c.base}/v1/synthesize`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(p.status, 401);
    // 設定画面の静的ファイルはトークン無しで返す（API の呼び出しにトークンを付ける）
    const page = await get('/admin/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal((await get('/admin/admin.js')).status, 200);
    assert.equal((await get('/admin/admin.css')).status, 200);
    const redirect = await fetch(`${c.base}/admin`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal((await get('/admin/../package.json')).status, 404);
  } finally {
    await c.stop();
  }
});

test('TTS_ADMIN_TOKEN が無ければ /v1/admin/* も TTS_TOKEN', async () => {
  const c = await start({ TTS_TOKEN: 'user-token' });
  try {
    assert.equal((await fetch(`${c.base}/v1/admin/status`)).status, 401);
    assert.equal((await fetch(`${c.base}/v1/admin/status`, { headers: { Authorization: 'Bearer user-token' } })).status, 200);
  } finally {
    await c.stop();
  }
});

test('許可リスト外の接続元は 403', async () => {
  const c = await start({ TTS_ALLOW_CIDRS: '192.0.2.0/24' });
  try {
    for (const path of ['/healthz', '/v1/engines', '/admin/']) {
      const r = await fetch(`${c.base}${path}`);
      assert.equal(r.status, 403, path);
      assert.equal(await errorCode(r), 'forbidden');
    }
  } finally {
    await c.stop();
  }
});

test('settings と catalog', async () => {
  const c = await start();
  try {
    const s = await (await fetch(`${c.base}/v1/admin/settings`)).json();
    assert.deepEqual(s, { defaultEngine: 'zen-tts', defaultVoices: { 'zen-tts': 'marine' }, idleUnloadSec: 600, cacheMaxMB: 500, cacheTtlDays: 30 });
    const put = (body: unknown) => fetch(`${c.base}/v1/admin/settings`, { ...json(body), method: 'PUT' });
    let r = await put({ idleUnloadSec: 0, cacheTtlDays: 7 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { defaultEngine: 'zen-tts', defaultVoices: { 'zen-tts': 'marine' }, idleUnloadSec: 0, cacheMaxMB: 500, cacheTtlDays: 7 });
    r = await put({ idleUnloadSec: 30 });
    assert.equal(r.status, 400);
    r = await put({ defaultVoices: { 'zen-tts': 'kikka' } });
    assert.equal(r.status, 400);
    assert.equal(((await (await fetch(`${c.base}/v1/admin/settings`)).json()) as { cacheTtlDays: number }).cacheTtlDays, 7);
    const cat = (await (await fetch(`${c.base}/v1/admin/catalog`)).json()) as { models: { id: string; registered: boolean; sha256: string }[] };
    assert.deepEqual(cat.models.map(m => [m.id, m.registered]), [['marine', true], ['hashiro', false], ['kai', false], ['kikka', false]]);
    assert.match(cat.models[0]!.sha256, /^c7bdad38/);
  } finally {
    await c.stop();
  }
});

test('models: 追加（URL）→ 取得 → installed、409、削除', async () => {
  const file = Buffer.alloc(3000, 1);
  const origin: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': String(file.length) });
    res.end(file);
  });
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/m.fake`;
  const c = await start();
  try {
    const post = (body: unknown) => fetch(`${c.base}/v1/admin/models`, json(body));
    let r = await post({ engine: 'zen-tts', id: 'mine', name: '自分の声', url });
    assert.equal(r.status, 202);
    assert.equal(((await r.json()) as { id: string }).id, 'mine');
    await c.app.downloader.wait('zen-tts', 'mine');
    const list = (await (await fetch(`${c.base}/v1/admin/models`)).json()) as { models: { id: string; status: string; bytes: number; source: { sha256: string } }[] };
    const mine = list.models.find(m => m.id === 'mine')!;
    assert.equal(mine.status, 'installed');
    assert.equal(mine.bytes, file.length);
    assert.match(mine.source.sha256, /^[0-9a-f]{64}$/);
    // 同じ id・不正な id・許可していないホスト・catalog と url の併用
    assert.equal((await post({ engine: 'zen-tts', id: 'mine', url })).status, 409);
    assert.equal((await post({ engine: 'zen-tts', id: 'Bad Id', url })).status, 400);
    assert.equal((await post({ engine: 'zen-tts', id: 'x', url: 'http://localhost/x' })).status, 400);
    assert.equal((await post({ engine: 'zen-tts', catalog: 'kikka', url })).status, 400);
    assert.equal((await post({ engine: 'zen-tts', catalog: 'nope' })).status, 404);
    assert.equal((await post({ engine: 'nope', id: 'x', url })).status, 404);
    // 取り直しは pending / error だけ
    r = await fetch(`${c.base}/v1/admin/models/zen-tts/mine/download`, { method: 'POST' });
    assert.equal(r.status, 409);
    // 既定の声は消せない
    assert.equal((await fetch(`${c.base}/v1/admin/models/zen-tts/marine`, { method: 'DELETE' })).status, 409);
    assert.equal((await fetch(`${c.base}/v1/admin/models/zen-tts/mine`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${c.base}/v1/admin/models/zen-tts/mine`, { method: 'DELETE' })).status, 404);
  } finally {
    await c.stop();
    await new Promise<void>(r => origin.close(() => r()));
  }
});
