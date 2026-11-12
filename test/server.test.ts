import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
    isPortAllowed: () => true,
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
