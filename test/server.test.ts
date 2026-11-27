import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { configureLog, setLogSink } from '../src/log.ts';
import { createApp, createHandler, type App, type AppOverrides } from '../src/server.ts';
import { FakeEngine, installedModel, tempDir } from './helpers.ts';

// アクセスログなどでテストの出力を埋めない（見るテストは captureLog で受ける）
const silence = (): void => setLogSink(() => {});
silence();

type Ctx = { base: string; port: number; app: App; engine: FakeEngine; stop: () => Promise<void> };

/** 偽のエンジンで起動する。env は loadConfig に渡す（TTS_PORT は空きポートにする。Host の検査が TTS_PORT を見るため） */
const start = async (env: Record<string, string> = {}, overrides: Partial<AppOverrides> = {}): Promise<Ctx> => {
  const { dir, cleanup } = await tempDir();
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig({ TTS_DATA_DIR: join(dir, 'data'), TTS_CACHE_DIR: join(dir, 'cache'), FFMPEG: 'false', TTS_PORT: String(port), ...env }, () => {});
  const engine = new FakeEngine();
  const app = await createApp(config, {
    engines: deps => {
      engine.registry = deps.registry;
      engine.settings = deps.settings;
      return new Map([[engine.id, engine]]);
    },
    isHostAllowed: h => h === '127.0.0.1',
    protocols: ['http:'],
    isPortAllowed: () => true,
    ...overrides,
  });
  await app.registry.add(installedModel('zen-tts', 'marine'));
  server.on('request', createHandler(app));
  const base = `http://127.0.0.1:${port}`;
  return {
    base, port, app, engine,
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
    const na = await fetch(`${c.base}/v1/engines`, { method: 'DELETE' });
    assert.equal(na.status, 405);
    assert.equal(await errorCode(na), 'method_not_allowed');
    assert.equal(na.headers.get('allow'), 'GET');
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
    // 読みの形（半角カナを含む）・頭字語・# で始まる語・未知のフィールド
    for (const [surface, body] of [
      ['Bar', { reading: 'ばー' }], ['Bar', { reading: 'ﾊﾞｰ' }], ['%23Bar', { reading: 'バー' }],
      ['Bar', { reading: 'バー', x: 1 }],
    ] as const) {
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
    // 管理トークンは通常の API にも使える（逆は不可）
    assert.equal((await get('/v1/engines', 'admin-token')).status, 200);
    assert.equal((await get('/v1/dictionary', 'admin-token')).status, 200);
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
    assert.equal((await get('/admin/../package.json', 'user-token')).status, 404);
    // 未定義のパスも認証が先
    assert.equal((await get('/v1/nope')).status, 401);
    assert.equal((await get('/v1/nope', 'user-token')).status, 404);
    assert.equal((await get('/v1/admin/nope', 'user-token')).status, 401);
    assert.equal((await get('/v1/admin/nope', 'admin-token')).status, 404);
    // 存在するパスへの未対応メソッドも認証が先
    assert.equal((await fetch(`${c.base}/v1/engines`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${c.base}/v1/engines`, { method: 'DELETE', headers: { Authorization: 'Bearer user-token' } })).status, 405);
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

test('models: 同時ダウンロードの上限（429）・登録数の上限（400）・重なった取り直し（409）', async () => {
  // /stall は一部だけ送って止まる。/file は全部返す
  const origin: Server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '3000' });
    if (req.url === '/file') res.end(Buffer.alloc(3000, 1));
    else res.write(Buffer.alloc(10, 1));
  });
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r));
  const o = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  const c = await start();
  try {
    const post = (body: unknown) => fetch(`${c.base}/v1/admin/models`, json(body));
    assert.equal((await post({ engine: 'zen-tts', id: 's1', url: `${o}/stall` })).status, 202);
    assert.equal((await post({ engine: 'zen-tts', id: 's2', url: `${o}/stall` })).status, 202);
    const r = await post({ engine: 'zen-tts', id: 's3', url: `${o}/stall` });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '5');
    assert.equal(c.app.registry.get('zen-tts', 's3'), undefined);
    // 取り直しも上限に数える
    await c.app.registry.add({ ...installedModel('zen-tts', 'e1'), status: 'error' });
    assert.equal((await fetch(`${c.base}/v1/admin/models/zen-tts/e1/download`, { method: 'POST' })).status, 429);
    // 取得中のものを消すと止まり、.part も残らない
    for (const id of ['s1', 's2']) assert.equal((await fetch(`${c.base}/v1/admin/models/zen-tts/${id}`, { method: 'DELETE' })).status, 204);
    assert.equal(c.app.downloader.isActive('zen-tts', 's1'), false);
    assert.equal(c.app.registry.get('zen-tts', 's1'), undefined);
    assert.equal(existsSync(`${c.app.registry.modelPath('zen-tts', 's1', '.fake')}.part`), false);

    // 同じ id の取り直しが重なったら 2 つ目は 409
    await c.app.registry.update('zen-tts', 'e1', { source: { url: `${o}/stall`, sha256: null } });
    const both = await Promise.all([1, 2].map(() => fetch(`${c.base}/v1/admin/models/zen-tts/e1/download`, { method: 'POST' })));
    assert.deepEqual(both.map(x => x.status).sort(), [202, 409]);
    const loser = both.find(x => x.status === 409)!;
    assert.equal(await errorCode(loser), 'conflict');
    assert.equal((await fetch(`${c.base}/v1/admin/models/zen-tts/e1`, { method: 'DELETE' })).status, 204);

    // 登録は合計 50 件まで（marine を含む）
    for (let i = c.app.registry.list().length; i < 50; i++) await c.app.registry.add(installedModel('zen-tts', `x${i}`));
    const full = await post({ engine: 'zen-tts', id: 'over', url: `${o}/file` });
    assert.equal(full.status, 400);
    assert.match(((await full.json()) as { error: { message: string } }).error.message, /50/);
  } finally {
    origin.closeAllConnections();
    await c.stop();
    await new Promise<void>(r => origin.close(() => r()));
  }
});

test('models: 削除の処理中（取得の終わりを待っている間）の同じ id の追加・取り直しは 409', async () => {
  const file = Buffer.alloc(3000, 1);
  const origin: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': String(file.length) });
    res.end(file);
  });
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/m.fake`;
  const c = await start();
  try {
    // 検査（verifying）で止めておく。削除は取得の終わりを待つので、その間が「削除の処理中」
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let verifying!: () => void;
    const reached = new Promise<void>(r => (verifying = r));
    c.engine.verifyModel = async () => {
      verifying();
      await gate;
      return { voiceId: 'fake' };
    };
    assert.equal((await fetch(`${c.base}/v1/admin/models`, json({ engine: 'zen-tts', id: 'mine', url }))).status, 202);
    await reached;
    const del = fetch(`${c.base}/v1/admin/models/zen-tts/mine`, { method: 'DELETE' });
    while (!c.app.downloader.isDeleting('zen-tts', 'mine')) await new Promise(r => setTimeout(r, 5));
    const again = await fetch(`${c.base}/v1/admin/models/zen-tts/mine/download`, { method: 'POST' });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: { message: string } }).error.message, /being deleted/);
    const add = await fetch(`${c.base}/v1/admin/models`, json({ engine: 'zen-tts', id: 'mine', url }));
    assert.equal(add.status, 409);
    assert.match(((await add.json()) as { error: { message: string } }).error.message, /being deleted/);
    release();
    assert.equal((await del).status, 204);
    assert.equal(c.app.registry.get('zen-tts', 'mine'), undefined);
    const path = c.app.registry.modelPath('zen-tts', 'mine', '.fake');
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.part`), false);
    // 削除が終われば同じ id で追加できる
    c.engine.verifyModel = async () => ({ voiceId: 'fake' });
    assert.equal((await fetch(`${c.base}/v1/admin/models`, json({ engine: 'zen-tts', id: 'mine', url }))).status, 202);
    await c.app.downloader.wait('zen-tts', 'mine');
    assert.equal(c.app.registry.get('zen-tts', 'mine')!.status, 'installed');
  } finally {
    await c.stop();
    await new Promise<void>(r => origin.close(() => r()));
  }
});

type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Host を自分で決めて送る（fetch は Host を付け替えるため） */
const raw = (c: Ctx, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Raw> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: c.port, method, path, headers, setHost: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });

const rawCode = (r: Raw): string => (JSON.parse(r.body) as { error: { code: string } }).error.code;

test('Host: TTS_HOSTS:TTS_PORT と localhost:TTS_PORT だけ。ほかと欠落は 421', async () => {
  const c = await start();
  try {
    for (const host of [`127.0.0.1:${c.port}`, `localhost:${c.port}`, `LocalHost:${c.port}`]) {
      assert.equal((await raw(c, 'GET', '/v1/engines', { Host: host })).status, 200, host);
    }
    for (const host of ['evil.example.com', `evil.example.com:${c.port}`, '127.0.0.1', `127.0.0.1:${c.port + 1}`, 'localhost', `[::1]:${c.port}`, '']) {
      for (const path of ['/healthz', '/v1/engines', '/admin/']) {
        const r = await raw(c, 'GET', path, { Host: host });
        assert.equal(r.status, 421, `${host} ${path}`);
        assert.equal(rawCode(r), 'misdirected_request');
      }
    }
    // Host 無し（HTTP/1.0）
    const res = await new Promise<string>((resolve, reject) => {
      const sock = connect(c.port, '127.0.0.1', () => sock.end('GET /healthz HTTP/1.0\r\n\r\n'));
      let data = '';
      sock.on('data', d => (data += d));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(res, /^HTTP\/1\.1 421 /);
  } finally {
    await c.stop();
  }
});

test('ffmpeg が無い: mp3 は 503、エンジンのサンプルレートの wav は 200、status に available=false', async () => {
  const c = await start({ FFMPEG: '/nonexistent/ffmpeg' });
  try {
    const st = (await (await fetch(`${c.base}/v1/admin/status`)).json()) as { ffmpeg: unknown };
    assert.deepEqual(st.ffmpeg, { available: false, path: '/nonexistent/ffmpeg', version: null, reason: 'spawn /nonexistent/ffmpeg ENOENT' });
    const mp3 = await fetch(`${c.base}/v1/synthesize`, json({ text: 'こんにちは。', format: 'mp3' }));
    assert.equal(mp3.status, 503);
    assert.deepEqual(await mp3.json(), { error: { code: 'engine_unavailable', message: 'ffmpeg is not available (/nonexistent/ffmpeg)' } });
    // リサンプルの要る wav も 503
    assert.equal((await fetch(`${c.base}/v1/synthesize`, json({ text: 'こんにちは。', sampleRate: 16000 }))).status, 503);
    assert.equal(c.engine.calls.length, 0);
    const wav = await fetch(`${c.base}/v1/synthesize`, json({ text: 'こんにちは。', sampleRate: 8000 }));
    assert.equal(wav.status, 200);
    assert.equal(wav.headers.get('content-type'), 'audio/wav');
  } finally {
    await c.stop();
  }
});

test('ffmpeg が probe の後に消えた: mp3 は 500 ではなく 503 engine_unavailable', async () => {
  const { dir, cleanup } = await tempDir();
  const fake = join(dir, 'ffmpeg');
  await writeFile(fake, '#!/bin/sh\necho "ffmpeg version 7.0.2"\n');
  await chmod(fake, 0o755);
  const c = await start({ FFMPEG: fake });
  try {
    const st = (await (await fetch(`${c.base}/v1/admin/status`)).json()) as { ffmpeg: { available: boolean } };
    assert.equal(st.ffmpeg.available, true);
    await rm(fake);
    const mp3 = await fetch(`${c.base}/v1/synthesize`, json({ text: 'こんにちは。', format: 'mp3' }));
    assert.equal(mp3.status, 503);
    assert.deepEqual(await mp3.json(), { error: { code: 'engine_unavailable', message: `ffmpeg is not available (${fake})` } });
  } finally {
    await c.stop();
    await cleanup();
  }
});

/** 条件が満たされるまで待つ（最大 2 秒） */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(cond());
};

test('synthesize: 合成中に接続を切るとエンジンの signal が abort され、キャッシュに書かない', async () => {
  const c = await start();
  try {
    c.engine.delayMs = 1000;
    const ac = new AbortController();
    const res = fetch(`${c.base}/v1/synthesize`, { ...json({ text: 'こんにちは。' }), signal: ac.signal });
    await until(() => c.engine.signals.length === 1);
    ac.abort();
    await assert.rejects(res);
    await until(() => c.engine.signals[0]!.aborted);
    await until(() => c.app.queue.stats().running === 0);
    c.engine.delayMs = 0;
    const r = await fetch(`${c.base}/v1/synthesize`, json({ text: 'こんにちは。' }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-cache'), 'miss');
  } finally {
    await c.stop();
  }
});

test('Host: TTS_ALLOWED_HOSTS はポートを問わず、大文字小文字を区別しない', async () => {
  const c = await start({ TTS_ALLOWED_HOSTS: 'tts.example.com, MyHost.tailnet.example' });
  try {
    for (const host of ['tts.example.com', 'TTS.example.com:443', `tts.example.com:${c.port}`, 'myhost.tailnet.example:8080', `127.0.0.1:${c.port}`]) {
      assert.equal((await raw(c, 'GET', '/healthz', { Host: host })).status, 200, host);
    }
    for (const host of ['x.tts.example.com', 'tts.example.com.evil.example', 'tts.example.com:abc', 'tts.example.com:']) {
      assert.equal((await raw(c, 'GET', '/healthz', { Host: host })).status, 421, host);
    }
  } finally {
    await c.stop();
  }
});

test('Host: IPv6 は [addr]:port、ポート 80 ならポート無しも可', async () => {
  const v6 = await start({ TTS_HOSTS: '::1' });
  try {
    assert.equal((await raw(v6, 'GET', '/healthz', { Host: `[::1]:${v6.port}` })).status, 200);
    assert.equal((await raw(v6, 'GET', '/healthz', { Host: `localhost:${v6.port}` })).status, 200);
    assert.equal((await raw(v6, 'GET', '/healthz', { Host: `127.0.0.1:${v6.port}` })).status, 421);
    assert.equal((await raw(v6, 'GET', '/healthz', { Host: '[::1]' })).status, 421);
  } finally {
    await v6.stop();
  }
  const p80 = await start({ TTS_PORT: '80' });
  try {
    for (const host of ['127.0.0.1', '127.0.0.1:80', 'localhost', 'localhost:80']) {
      assert.equal((await raw(p80, 'GET', '/healthz', { Host: host })).status, 200, host);
    }
    assert.equal((await raw(p80, 'GET', '/healthz', { Host: `127.0.0.1:${p80.port}` })).status, 421);
  } finally {
    await p80.stop();
  }
});

test('Origin: GET / HEAD / OPTIONS 以外で許可外・null なら 403、無ければ通す', async () => {
  const c = await start({ TTS_ALLOWED_HOSTS: 'tts.example.com' });
  try {
    const host = `127.0.0.1:${c.port}`;
    const post = (headers: Record<string, string>) =>
      raw(c, 'POST', '/v1/normalize', { Host: host, 'Content-Type': 'application/json', ...headers }, JSON.stringify({ text: 'a' }));
    assert.equal((await post({})).status, 200);
    assert.equal((await post({ Origin: `http://127.0.0.1:${c.port}` })).status, 200);
    assert.equal((await post({ Origin: `http://localhost:${c.port}` })).status, 200);
    assert.equal((await post({ Origin: 'https://tts.example.com' })).status, 200);
    for (const origin of ['http://evil.example.com', `http://evil.example.com:${c.port}`, 'http://127.0.0.1', `http://127.0.0.1:${c.port + 1}`, 'null', 'garbage']) {
      const r = await post({ Origin: origin });
      assert.equal(r.status, 403, origin);
      assert.equal(rawCode(r), 'forbidden_origin');
    }
    // 管理 API の PUT / DELETE も同じ
    assert.equal((await raw(c, 'DELETE', '/v1/admin/cache', { Host: host, Origin: 'http://evil.example.com' })).status, 403);
    // 読むだけのメソッドは Origin を見ない
    assert.equal((await raw(c, 'GET', '/v1/engines', { Host: host, Origin: 'http://evil.example.com' })).status, 200);
    assert.equal((await raw(c, 'HEAD', '/healthz', { Host: host, Origin: 'null' })).status, 200);
  } finally {
    await c.stop();
  }
});

test('400（不正なリクエストターゲット）・405・415（本文が空でも）・HEAD /healthz', async () => {
  const c = await start();
  try {
    const host = `127.0.0.1:${c.port}`;
    const bad = await raw(c, 'GET', '//', { Host: host });
    assert.equal(bad.status, 400);
    assert.equal(rawCode(bad), 'bad_request');

    const head = await raw(c, 'HEAD', '/healthz', { Host: host });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    for (const [method, path, allow] of [
      ['POST', '/healthz', 'GET, HEAD'],
      ['PUT', '/v1/synthesize', 'POST'],
      ['POST', '/v1/admin/settings', 'GET, PUT'],
      ['POST', '/admin/', 'GET, HEAD'],
      ['DELETE', '/admin', 'GET, HEAD'],
    ] as const) {
      const r = await raw(c, method, path, { Host: host });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.equal(rawCode(r), 'method_not_allowed');
      assert.equal(r.headers.allow, allow, `${method} ${path}`);
    }

    for (const [method, path] of [['POST', '/v1/synthesize'], ['POST', '/v1/normalize'], ['PUT', '/v1/admin/settings'], ['POST', '/v1/admin/models'], ['PUT', '/v1/admin/dictionary/Foo']] as const) {
      for (const headers of [{}, { 'Content-Type': 'text/plain' }, { 'Content-Length': '0' }]) {
        const r = await raw(c, method, path, { Host: host, ...headers });
        assert.equal(r.status, 415, `${method} ${path} ${JSON.stringify(headers)}`);
        assert.equal(rawCode(r), 'unsupported_media_type');
      }
    }
  } finally {
    await c.stop();
  }
});

test('synthesize: 合流中は 1 人が切断しても合成を続け、残った要求に返す。全員が切断したら止める', async () => {
  const c = await start();
  try {
    c.engine.delayMs = 300;
    const body = json({ text: 'こんにちは。' });
    const ac = new AbortController();
    const gone = fetch(`${c.base}/v1/synthesize`, { ...body, signal: ac.signal });
    await until(() => c.engine.signals.length === 1);
    const stay = fetch(`${c.base}/v1/synthesize`, body);
    // 合流するまで待ってから切る
    await new Promise(r => setTimeout(r, 50));
    ac.abort();
    await assert.rejects(gone);
    const r = await stay;
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-cache'), 'miss');
    assert.equal(c.engine.calls.length, 1);
    assert.equal(c.engine.signals[0]!.aborted, false);

    // 全員が切断
    c.engine.delayMs = 1000;
    const body2 = json({ text: 'さようなら。' });
    const acs = [new AbortController(), new AbortController()];
    // 切った方の reject を待つ間に未処理にしない
    const both = acs.map(a => fetch(`${c.base}/v1/synthesize`, { ...body2, signal: a.signal }).then(() => 'ok', () => 'aborted'));
    await until(() => c.engine.signals.length === 2);
    await new Promise(r => setTimeout(r, 50));
    acs[0]!.abort();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(c.engine.signals[1]!.aborted, false);
    acs[1]!.abort();
    assert.deepEqual(await Promise.all(both), ['aborted', 'aborted']);
    await until(() => c.engine.signals[1]!.aborted);
    assert.equal(c.engine.calls.length, 2);
  } finally {
    await c.stop();
  }
});

// ---- ヘルスチェック・リクエスト ID・アクセスログ ----

/** json 形式のログを受ける。stop で元（出さない）に戻す */
const captureLog = (level = 'info'): { lines: Record<string, unknown>[]; raw: string[]; stop: () => void } => {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  configureLog({ LOG_FORMAT: 'json', LOG_LEVEL: level });
  setLogSink((_stream, line) => {
    raw.push(line);
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return {
    lines, raw,
    stop: () => {
      configureLog({});
      silence();
    },
  };
};

/** アクセスログは応答の close で出るので、少し待つ */
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 20));
};

test('health: /health・/health/live・/health/ready は認証不要で 200、HEAD 可、POST は 405', async () => {
  const c = await start({ TTS_TOKEN: 'u'.repeat(32), TTS_ADMIN_TOKEN: 'a'.repeat(32) });
  try {
    const host = `127.0.0.1:${c.port}`;
    for (const path of ['/healthz', '/health', '/health/live', '/health/ready']) {
      const r = await raw(c, 'GET', path, { Host: host });
      assert.equal(r.status, 200, path);
      assert.deepEqual(JSON.parse(r.body), { status: 'ok', version: '0.1.0' }, path);
      assert.equal(r.headers['cache-control'], 'no-store');
      const head = await raw(c, 'HEAD', path, { Host: host });
      assert.equal(head.status, 200, path);
      assert.equal(head.body, '');
      const post = await raw(c, 'POST', path, { Host: host });
      assert.equal(post.status, 405, path);
      assert.equal(rawCode(post), 'method_not_allowed');
      assert.equal(post.headers.allow, 'GET, HEAD', path);
    }
    // 認証が要るルートは今までどおり 401
    assert.equal((await raw(c, 'GET', '/v1/engines', { Host: host })).status, 401);
    // Host 検査は通常どおり
    assert.equal((await raw(c, 'GET', '/health/ready', { Host: 'evil.example.com' })).status, 421);
  } finally {
    await c.stop();
  }
});

test('health/ready: 終了処理中・データディレクトリに書けない・無いときは 503 と reason', async () => {
  const c = await start();
  try {
    const host = `127.0.0.1:${c.port}`;
    c.app.shuttingDown = true;
    let r = await raw(c, 'GET', '/health/ready', { Host: host });
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.body), { status: 'unavailable', reason: 'shutting down' });
    assert.equal(r.headers['retry-after'], undefined);
    // live は終了処理中でも 200
    assert.equal((await raw(c, 'GET', '/health/live', { Host: host })).status, 200);
    c.app.shuttingDown = false;

    await chmod(c.app.config.dataDir, 0o500);
    try {
      r = await raw(c, 'GET', '/health/ready', { Host: host });
      assert.equal(r.status, 503);
      assert.deepEqual(JSON.parse(r.body), { status: 'unavailable', reason: 'data directory is not writable' });
      assert.equal((await raw(c, 'HEAD', '/health/ready', { Host: host })).status, 503);
    } finally {
      await chmod(c.app.config.dataDir, 0o700);
    }
    assert.equal((await raw(c, 'GET', '/health/ready', { Host: host })).status, 200);

    await rm(c.app.config.dataDir, { recursive: true, force: true });
    r = await raw(c, 'GET', '/health/ready', { Host: host });
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.body), { status: 'unavailable', reason: 'data directory is not writable' });
  } finally {
    await c.stop();
  }
});

test('health/ready: close() の先頭で shuttingDown が true になる', async () => {
  const c = await start();
  try {
    assert.equal(c.app.shuttingDown, false);
  } finally {
    await c.stop();
  }
  assert.equal(c.app.shuttingDown, true);
});

test('X-Request-Id: 生成・引き継ぎ・不正な値は無視・Cf-Ray の採用。エラー・静的ファイルにも付く', async () => {
  const c = await start();
  try {
    const host = `127.0.0.1:${c.port}`;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const a = await raw(c, 'GET', '/healthz', { Host: host });
    const b = await raw(c, 'GET', '/healthz', { Host: host });
    assert.match(a.headers['x-request-id'] as string, uuid);
    assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
    assert.equal((await raw(c, 'GET', '/healthz', { Host: host, 'X-Request-Id': 'abc.DEF_1-2' })).headers['x-request-id'], 'abc.DEF_1-2');
    for (const bad of ['has space', 'a/b', 'x'.repeat(65), 'a:b', '']) {
      const r = await raw(c, 'GET', '/healthz', { Host: host, 'X-Request-Id': bad });
      assert.match(r.headers['x-request-id'] as string, uuid, bad);
    }
    assert.equal((await raw(c, 'GET', '/healthz', { Host: host, 'Cf-Ray': '8a1b2c3d4e5f6789-NRT' })).headers['x-request-id'], '8a1b2c3d4e5f6789-NRT');
    // X-Request-Id が優先、不正なら Cf-Ray
    assert.equal((await raw(c, 'GET', '/healthz', { Host: host, 'X-Request-Id': 'mine', 'Cf-Ray': 'ray-1' })).headers['x-request-id'], 'mine');
    assert.equal((await raw(c, 'GET', '/healthz', { Host: host, 'X-Request-Id': 'bad id', 'Cf-Ray': 'ray-1' })).headers['x-request-id'], 'ray-1');
    // エラー（421・404・405・400）、静的ファイル、リダイレクト、204、音声
    for (const [method, path, h, status] of [
      ['GET', '/healthz', 'evil.example.com', 421],
      ['GET', '/v1/nope', host, 404],
      ['POST', '/healthz', host, 405],
      ['GET', '//', host, 400],
      ['GET', '/admin/', host, 200],
      ['GET', '/admin', host, 301],
      ['DELETE', '/v1/admin/cache', host, 204],
    ] as const) {
      const r = await raw(c, method, path, { Host: h, 'X-Request-Id': 'rid-1' });
      assert.equal(r.status, status, `${method} ${path}`);
      assert.equal(r.headers['x-request-id'], 'rid-1', `${method} ${path}`);
    }
    const s = await fetch(`${c.base}/v1/synthesize`, json({ text: 'あ' }, { 'X-Request-Id': 'rid-2' }));
    assert.equal(s.status, 200);
    assert.equal(s.headers.get('x-request-id'), 'rid-2');
    await s.arrayBuffer();
  } finally {
    await c.stop();
  }
});

test('アクセスログ: 1 要求 1 行。トークン・クエリ文字列・ヘッダは出さない。health は debug', async () => {
  const secret = 's3cr3t-token-value-0123456789';
  const c = await start({ TTS_TOKEN: secret });
  const log = captureLog();
  try {
    const r = await fetch(`${c.base}/v1/engines?q=QUERYSECRET&token=${secret}`, { headers: { Authorization: `Bearer ${secret}`, 'X-Request-Id': 'rid-log' } });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    await waitFor(() => log.lines.length >= 1);
    assert.equal(log.lines.length, 1);
    const l = log.lines[0]!;
    assert.equal(l.level, 'info');
    assert.equal(l.msg, 'request');
    assert.equal(l.requestId, 'rid-log');
    assert.equal(l.method, 'GET');
    assert.equal(l.path, '/v1/engines');
    assert.equal(l.status, 200);
    assert.equal(typeof l.durationMs, 'number');
    assert.equal(l.remote, '127.0.0.1');
    assert.equal(l.bytes, Number(r.headers.get('content-length')));
    assert.equal(l.aborted, undefined);

    // 401 も 1 行、トークンもクエリも出ない
    await (await fetch(`${c.base}/v1/engines?token=${secret}`, { headers: { Authorization: 'Bearer wrong-token-QUERYSECRET' } })).arrayBuffer();
    await waitFor(() => log.lines.length >= 2);
    assert.equal(log.lines.length, 2);
    assert.equal(log.lines[1]!.status, 401);
    const all = log.raw.join('\n');
    assert.doesNotMatch(all, new RegExp(secret));
    assert.doesNotMatch(all, /QUERYSECRET/);
    assert.doesNotMatch(all, /token=/);
    assert.doesNotMatch(all, /authorization/i);

    // health は info では出ない
    for (const path of ['/healthz', '/health', '/health/live', '/health/ready']) await (await fetch(`${c.base}${path}`)).arrayBuffer();
    await waitFor(() => false);
    assert.equal(log.lines.length, 2);
  } finally {
    log.stop();
    await c.stop();
  }
});

test('アクセスログ: health は debug で出る。解釈できないパスは -', async () => {
  const c = await start();
  const log = captureLog('debug');
  try {
    await (await fetch(`${c.base}/health/ready`)).arrayBuffer();
    await raw(c, 'GET', '//', { Host: `127.0.0.1:${c.port}` });
    await waitFor(() => log.lines.length >= 2);
    const req = log.lines.filter(l => l.msg === 'request');
    assert.equal(req.length, 2);
    assert.equal(req[0]!.level, 'debug');
    assert.equal(req[0]!.path, '/health/ready');
    assert.equal(req[1]!.level, 'info');
    assert.equal(req[1]!.path, '-');
    assert.equal(req[1]!.status, 400);
  } finally {
    log.stop();
    await c.stop();
  }
});

test('アクセスログ: 応答前に切断したら status 0・aborted。500 は error で requestId と stack', async () => {
  const c = await start();
  const log = captureLog();
  try {
    c.engine.delayMs = 2000;
    const ac = new AbortController();
    const p = fetch(`${c.base}/v1/synthesize`, { ...json({ text: 'あ' }, { 'X-Request-Id': 'rid-abort' }), signal: ac.signal }).catch(() => null);
    while (c.engine.calls.length === 0) await new Promise(r => setTimeout(r, 5));
    ac.abort();
    await p;
    await waitFor(() => log.lines.some(l => l.msg === 'request' && l.requestId === 'rid-abort'));
    const line = log.lines.find(l => l.msg === 'request' && l.requestId === 'rid-abort')!;
    assert.equal(line.status, 0);
    assert.equal(line.aborted, true);
    await waitFor(() => log.lines.some(l => l.msg === 'client disconnected before the response'));
    const disc = log.lines.find(l => l.msg === 'client disconnected before the response')!;
    assert.equal(disc.level, 'info');
    assert.equal(disc.requestId, 'rid-abort');
    assert.equal(disc.path, '/v1/synthesize');

    c.engine.delayMs = 0;
    c.app.synth.normalize = () => {
      throw new Error('kaboom');
    };
    const r = await fetch(`${c.base}/v1/normalize?x=QUERYSECRET`, json({ text: 'a' }, { 'X-Request-Id': 'rid-500' }));
    assert.equal(r.status, 500);
    await r.arrayBuffer();
    await waitFor(() => log.lines.some(l => l.msg === 'request' && l.requestId === 'rid-500'));
    const err = log.lines.find(l => l.level === 'error' && l.requestId === 'rid-500')!;
    assert.equal(err.msg, 'internal error');
    assert.equal(err.method, 'POST');
    assert.equal(err.path, '/v1/normalize');
    assert.equal((err.err as { message: string }).message, 'kaboom');
    assert.match((err.err as { stack: string }).stack, /kaboom/);
    assert.doesNotMatch(log.raw.join('\n'), /QUERYSECRET/);
  } finally {
    log.stop();
    await c.stop();
  }
});

test('Host: TTS_HOSTS=0.0.0.0 は 127.0.0.1:port・localhost:port・TTS_ALLOWED_HOSTS を許し、0.0.0.0:port は 421', async () => {
  const c = await start({ TTS_HOSTS: '0.0.0.0', TTS_ALLOW_ANY_ADDRESS: '1', TTS_TOKEN: 't'.repeat(32), TTS_ALLOWED_HOSTS: 'tts.example.com' });
  try {
    for (const host of [`127.0.0.1:${c.port}`, `localhost:${c.port}`, 'tts.example.com', `tts.example.com:${c.port}`]) {
      assert.equal((await raw(c, 'GET', '/health', { Host: host })).status, 200, host);
    }
    for (const host of [`0.0.0.0:${c.port}`, '0.0.0.0', `[::1]:${c.port}`, `[::]:${c.port}`, 'evil.example.com']) {
      assert.equal((await raw(c, 'GET', '/health', { Host: host })).status, 421, host);
    }
    // 未指定アドレスはループバック以外なのでトークンが要る
    assert.equal((await raw(c, 'GET', '/v1/engines', { Host: `127.0.0.1:${c.port}` })).status, 401);
  } finally {
    await c.stop();
  }
  const v6 = await start({ TTS_HOSTS: '::', TTS_ALLOW_ANY_ADDRESS: '1', TTS_TOKEN: 't'.repeat(32) });
  try {
    for (const host of [`[::1]:${v6.port}`, `localhost:${v6.port}`]) {
      assert.equal((await raw(v6, 'GET', '/health', { Host: host })).status, 200, host);
    }
    for (const host of [`[::]:${v6.port}`, `127.0.0.1:${v6.port}`, `0.0.0.0:${v6.port}`]) {
      assert.equal((await raw(v6, 'GET', '/health', { Host: host })).status, 421, host);
    }
  } finally {
    await v6.stop();
  }
});

// ---- 発行した API トークン ----

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ADMIN = 'admin-token-for-tests';
const USER = 'user-token-for-tests';

const bearer = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

type Issued = { id: string; label: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; expired: boolean; token: string };

const issue = async (c: Ctx, by: string | undefined, body: unknown = { label: 'pixel', expiresInSec: 3600 }): Promise<Response> =>
  fetch(`${c.base}/v1/admin/tokens`, json(body, bearer(by)));

const issued = async (c: Ctx, by: string | undefined, body?: unknown): Promise<Issued> => {
  const r = await issue(c, by, body);
  assert.equal(r.status, 201);
  return (await r.json()) as Issued;
};

/** 通常の API 4 つを token で呼んで status を返す */
const userApis = async (c: Ctx, token: string): Promise<number[]> => {
  const out: number[] = [];
  for (const [method, path, body] of [
    ['GET', '/v1/engines', undefined],
    ['GET', '/v1/dictionary', undefined],
    ['POST', '/v1/normalize', { text: 'GitHub' }],
    ['POST', '/v1/synthesize', { text: 'あ' }],
  ] as const) {
    const r = await fetch(`${c.base}${path}`, body === undefined ? { method, headers: bearer(token) } : json(body, bearer(token)));
    await r.arrayBuffer();
    out.push(r.status);
  }
  return out;
};

test('API トークン: 管理トークンで発行し、その値で通常の API が 200、管理 API は 401（構成 D）', async () => {
  const c = await start({ TTS_TOKEN: USER, TTS_ADMIN_TOKEN: ADMIN }, { now: () => T0 });
  try {
    const r = await issue(c, ADMIN);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const t = (await r.json()) as Issued & { hash?: string };
    assert.deepEqual(Object.keys(t).sort(), ['createdAt', 'expired', 'expiresAt', 'id', 'label', 'lastUsedAt', 'token']);
    assert.equal(t.hash, undefined);
    assert.match(t.token, /^ttsg_[0-9a-f]{8}_[0-9a-f]{48}$/);
    assert.equal(t.token.slice(5, 13), t.id);
    assert.equal(t.label, 'pixel');
    assert.equal(t.createdAt, '2026-01-01T00:00:00Z');
    assert.equal(t.expiresAt, '2026-01-01T01:00:00Z');
    assert.equal(t.lastUsedAt, null);
    assert.equal(t.expired, false);
    assert.deepEqual(await userApis(c, t.token), [200, 200, 200, 200]);

    // 管理 API は読み取りも含めて 401
    for (const [method, path] of [
      ['GET', '/v1/admin/status'],
      ['GET', '/v1/admin/tokens'],
      ['POST', '/v1/admin/tokens'],
      ['DELETE', `/v1/admin/tokens/${t.id}`],
      ['GET', '/v1/admin/nope'],
    ] as const) {
      const res = await fetch(`${c.base}${path}`, method === 'POST' ? json({ label: 'x', expiresInSec: 3600 }, bearer(t.token)) : { method, headers: bearer(t.token) });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      assert.equal(await errorCode(res), 'unauthorized');
    }
    // 未定義のパス・未対応メソッドは認証を通ってから 404 / 405
    assert.equal((await fetch(`${c.base}/v1/nope`, { headers: bearer(t.token) })).status, 404);
    assert.equal((await fetch(`${c.base}/v1/engines`, { method: 'DELETE', headers: bearer(t.token) })).status, 405);
    // TTS_TOKEN では発行・一覧・失効ができない
    assert.equal((await issue(c, USER)).status, 401);
    assert.equal((await fetch(`${c.base}/v1/admin/tokens`, { headers: bearer(USER) })).status, 401);
    assert.equal((await fetch(`${c.base}/v1/admin/tokens/${t.id}`, { method: 'DELETE', headers: bearer(USER) })).status, 401);
    // 発行したものはまだ使える
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(t.token) })).status, 200);
  } finally {
    await c.stop();
  }
});

test('API トークン: 構成 C（TTS_TOKEN だけ）では TTS_TOKEN で発行でき、発行トークンは管理 API に 401', async () => {
  const c = await start({ TTS_TOKEN: USER });
  try {
    const t = await issued(c, USER);
    assert.deepEqual(await userApis(c, t.token), [200, 200, 200, 200]);
    assert.equal((await fetch(`${c.base}/v1/admin/status`, { headers: bearer(t.token) })).status, 401);
    assert.equal((await fetch(`${c.base}/v1/admin/tokens`, { headers: bearer(t.token) })).status, 401);
    assert.equal((await fetch(`${c.base}/v1/admin/status`, { headers: bearer(USER) })).status, 200);
  } finally {
    await c.stop();
  }
});

test('API トークン: 構成 A・B では発行は 409、一覧は enabled: false。B の通常 API は何を付けても 200', async () => {
  const a = await start();
  try {
    const r = await issue(a, undefined);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: { code: 'conflict', message: 'API tokens require TTS_TOKEN to be set' } });
    assert.deepEqual(await (await fetch(`${a.base}/v1/admin/tokens`)).json(), { enabled: false, tokens: [] });
  } finally {
    await a.stop();
  }
  const b = await start({ TTS_ADMIN_TOKEN: ADMIN });
  try {
    assert.equal((await issue(b, ADMIN)).status, 409);
    assert.equal((await issue(b, undefined)).status, 401);
    assert.deepEqual(await (await fetch(`${b.base}/v1/admin/tokens`, { headers: bearer(ADMIN) })).json(), { enabled: false, tokens: [] });
    for (const token of [undefined, 'whatever', `ttsg_${'0'.repeat(8)}_${'0'.repeat(48)}`, ADMIN]) {
      assert.equal((await fetch(`${b.base}/v1/engines`, { headers: bearer(token) })).status, 200, String(token));
    }
  } finally {
    await b.stop();
  }
});

test('API トークン: 期限切れと失効後は 401。失効は 204、2 回目・無い id・形の違う id は 404', async () => {
  let t = T0;
  const c = await start({ TTS_TOKEN: USER, TTS_ADMIN_TOKEN: ADMIN }, { now: () => t });
  try {
    const short = await issued(c, ADMIN, { label: 'short', expiresInSec: 3600 });
    const long = await issued(c, ADMIN, { label: 'long', expiresInSec: 86400 });
    t = T0 + 3_600_000 - 1;
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(short.token) })).status, 200);
    t = T0 + 3_600_000;
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(short.token) })).status, 401);
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(long.token) })).status, 200);
    const del = (id: string) => fetch(`${c.base}/v1/admin/tokens/${id}`, { method: 'DELETE', headers: bearer(ADMIN) });
    const r = await del(long.id);
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(long.token) })).status, 401);
    let nf = await del(long.id);
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: { code: 'not_found', message: `token ${long.id} not found` } });
    nf = await del('zzz');
    assert.equal(nf.status, 404);
    assert.equal(await errorCode(nf), 'not_found');
    assert.equal((await del('00000000')).status, 404);
    // 期限切れも消せる
    assert.equal((await del(short.id)).status, 204);
    // 本文の Content-Type 違いは 415
    const bad = await fetch(`${c.base}/v1/admin/tokens/${short.id}`, { method: 'DELETE', headers: { ...bearer(ADMIN), 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(bad.status, 415);
  } finally {
    await c.stop();
  }
});

test('API トークン: 本文の検査（400 と field）・415・ラベルの trim', async () => {
  const c = await start({ TTS_TOKEN: USER, TTS_ADMIN_TOKEN: ADMIN });
  try {
    const cases: [unknown, string, string][] = [
      [{ label: 'a', expiresInSec: 3600, x: 1 }, 'x', 'unknown field x'],
      [{ expiresInSec: 3600 }, 'label', 'label is required'],
      [{ label: '   ', expiresInSec: 3600 }, 'label', 'label must be 1 to 40 characters'],
      [{ label: 'あ'.repeat(41), expiresInSec: 3600 }, 'label', 'label must be 1 to 40 characters'],
      [{ label: 'a\u0007b', expiresInSec: 3600 }, 'label', 'label must not contain control characters'],
      [{ label: 1, expiresInSec: 3600 }, 'label', 'label must be a string'],
      [{ label: 'a' }, 'expiresInSec', 'expiresInSec is required'],
      [{ label: 'a', expiresInSec: 60 }, 'expiresInSec', 'expiresInSec must be one of 3600, 86400, 604800, 2592000, 7776000, 31536000 or null'],
      [{ label: 'a', expiresInSec: '3600' }, 'expiresInSec', 'expiresInSec must be one of 3600, 86400, 604800, 2592000, 7776000, 31536000 or null'],
    ];
    for (const [body, field, message] of cases) {
      const r = await issue(c, ADMIN, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(await r.json(), { error: { code: 'invalid_request', message, field } }, JSON.stringify(body));
    }
    const r = await fetch(`${c.base}/v1/admin/tokens`, { method: 'POST', headers: { ...bearer(ADMIN), 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
    assert.equal((await issued(c, ADMIN, { label: '字'.repeat(40), expiresInSec: 2592000 })).label, '字'.repeat(40));
    const trimmed = await issued(c, ADMIN, { label: '  計測 Bot  ', expiresInSec: 604800 });
    assert.equal(trimmed.label, '計測 Bot');
    assert.equal(c.app.tokens.list().length, 2);
  } finally {
    await c.stop();
  }
});

test('API トークン: 有効 20 件を超える発行は 400（field なし）', async () => {
  const c = await start({ TTS_TOKEN: USER });
  try {
    for (let i = 0; i < 20; i++) await issued(c, USER, { label: `t${i}`, expiresInSec: 3600 });
    const r = await issue(c, USER);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: { code: 'invalid_request', message: 'too many active tokens (up to 20)' } });
  } finally {
    await c.stop();
  }
});

test('API トークン: 一覧は新しい順、使用後に lastUsedAt、期限切れは expired', async () => {
  let t = T0;
  const c = await start({ TTS_TOKEN: USER, TTS_ADMIN_TOKEN: ADMIN }, { now: () => t });
  try {
    const a = await issued(c, ADMIN, { label: 'a', expiresInSec: 3600 });
    t += 1000;
    const b = await issued(c, ADMIN, { label: 'b', expiresInSec: 86400 });
    const b2 = await issued(c, ADMIN, { label: 'b2', expiresInSec: 86400 });
    const list = async () => (await (await fetch(`${c.base}/v1/admin/tokens`, { headers: bearer(ADMIN) })).json()) as { enabled: boolean; tokens: (Omit<Issued, 'token'> & { hash?: string; token?: string })[] };
    let l = await list();
    assert.equal(l.enabled, true);
    // 同じ時刻は追加の新しい順
    assert.deepEqual(l.tokens.map(x => x.id), [b2.id, b.id, a.id]);
    assert.ok(l.tokens.every(x => x.hash === undefined && x.token === undefined));
    t += 4000;
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(a.token) })).status, 200);
    l = await list();
    assert.equal(l.tokens.find(x => x.id === a.id)!.lastUsedAt, '2026-01-01T00:00:05Z');
    assert.equal(l.tokens.find(x => x.id === b.id)!.lastUsedAt, null);
    t = T0 + 3_600_000;
    l = await list();
    assert.deepEqual(l.tokens.map(x => [x.label, x.expired]), [['b2', false], ['b', false], ['a', true]]);
  } finally {
    await c.stop();
  }
});

test('API トークン: ログに値・secret・hash が出ない。発行・失効のログと tokenId', async () => {
  const c = await start({ TTS_TOKEN: USER, TTS_ADMIN_TOKEN: ADMIN });
  const log = captureLog('debug');
  try {
    const t = await issued(c, ADMIN, { label: 'bot', expiresInSec: 3600 });
    const hash = createHash('sha256').update(t.token).digest('hex');
    await (await fetch(`${c.base}/v1/engines`, { headers: { ...bearer(t.token), 'X-Request-Id': 'rid-issued' } })).arrayBuffer();
    await (await fetch(`${c.base}/v1/engines`, { headers: { ...bearer(USER), 'X-Request-Id': 'rid-user' } })).arrayBuffer();
    await (await fetch(`${c.base}/v1/engines`, { headers: { ...bearer(`${t.token}0`), 'X-Request-Id': 'rid-401' } })).arrayBuffer();
    await (await fetch(`${c.base}/v1/admin/status`, { headers: { ...bearer(t.token), 'X-Request-Id': 'rid-admin-401' } })).arrayBuffer();
    const d = await fetch(`${c.base}/v1/admin/tokens/${t.id}`, { method: 'DELETE', headers: { ...bearer(ADMIN), 'X-Request-Id': 'rid-revoke' } });
    assert.equal(d.status, 204);
    await (await fetch(`${c.base}/v1/engines`, { headers: { ...bearer(t.token), 'X-Request-Id': 'rid-revoked' } })).arrayBuffer();
    await waitFor(() => log.lines.filter(l => l.msg === 'request').length >= 7);

    const all = log.raw.join('\n');
    assert.ok(!all.includes(t.token));
    assert.ok(!all.includes(t.token.slice(14)));
    assert.ok(!all.includes(hash));

    const issuedLog = log.lines.find(l => l.msg === 'api token issued')!;
    assert.equal(issuedLog.level, 'info');
    assert.equal(issuedLog.tokenId, t.id);
    assert.equal(issuedLog.label, 'bot');
    assert.equal(issuedLog.expiresAt, t.expiresAt);
    assert.equal(issuedLog.method, 'POST');
    assert.equal(issuedLog.path, '/v1/admin/tokens');
    assert.equal(typeof issuedLog.requestId, 'string');
    const revoked = log.lines.find(l => l.msg === 'api token revoked')!;
    assert.equal(revoked.tokenId, t.id);
    assert.equal(revoked.label, 'bot');
    assert.equal(revoked.requestId, 'rid-revoke');

    const req = (rid: string) => log.lines.find(l => l.msg === 'request' && l.requestId === rid)!;
    assert.equal(req('rid-issued').tokenId, t.id);
    assert.equal(req('rid-issued').status, 200);
    for (const rid of ['rid-user', 'rid-401', 'rid-admin-401', 'rid-revoked']) assert.equal(req(rid).tokenId, undefined, rid);
    assert.equal(req('rid-401').status, 401);
    assert.equal(req('rid-admin-401').status, 401);
  } finally {
    log.stop();
    await c.stop();
  }
});

test('API トークン: close で lastUsedAt がファイルに書かれる。ファイルは 0600', async () => {
  let t = T0;
  const c = await start({ TTS_TOKEN: USER }, { now: () => t });
  const path = join(c.app.config.dataDir, 'api-tokens.json');
  try {
    const tk = await issued(c, USER);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    t += 7000;
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(tk.token) })).status, 200);
    const read = async () => JSON.parse(await readFile(path, 'utf8')) as { tokens: { lastUsedAt: string | null }[] };
    assert.equal((await read()).tokens[0]!.lastUsedAt, null);
    await c.app.close();
    assert.equal((await read()).tokens[0]!.lastUsedAt, '2026-01-01T00:00:07Z');
    assert.ok(!(await readFile(path, 'utf8')).includes(tk.token));
  } finally {
    await c.stop();
  }
});

test('API トークン: 設定画面に API トークンのカードがある', async () => {
  const c = await start();
  try {
    const html = await (await fetch(`${c.base}/admin/`)).text();
    assert.match(html, /id="apitokens-card"/);
  } finally {
    await c.stop();
  }
});

test('API トークン: expiresInSec に 90 日・1 年・null（無期限）を指定できる', async () => {
  const c = await start({ TTS_TOKEN: USER, TTS_ADMIN_TOKEN: ADMIN }, { now: () => T0 });
  try {
    assert.equal((await issued(c, ADMIN, { label: 'q', expiresInSec: 7776000 })).expiresAt, '2026-04-01T00:00:00Z');
    assert.equal((await issued(c, ADMIN, { label: 'y', expiresInSec: 31536000 })).expiresAt, '2027-01-01T00:00:00Z');
    const t = await issued(c, ADMIN, { label: 'forever', expiresInSec: null });
    assert.equal(t.expiresAt, null);
    assert.equal(t.expired, false);
    assert.equal((await fetch(`${c.base}/v1/engines`, { headers: bearer(t.token) })).status, 200);
    const list = (await (await fetch(`${c.base}/v1/admin/tokens`, { headers: bearer(ADMIN) })).json()) as { tokens: { label: string; expiresAt: string | null }[] };
    assert.equal(list.tokens.find(x => x.label === 'forever')!.expiresAt, null);
  } finally {
    await c.stop();
  }
});
