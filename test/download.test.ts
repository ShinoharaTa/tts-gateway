import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import { checkUrl, DownloadError, downloadFile, hostAllowed, MAX_REDIRECTS, ModelDownloader } from '../src/models/download.ts';
import { Registry } from '../src/models/registry.ts';
import { FakeEngine, tempDir } from './helpers.ts';

const BODY = Buffer.alloc(5000, 7);
const SHA = createHash('sha256').update(BODY).digest('hex');
let server: Server;
let base = '';
let otherBase = '';

before(async () => {
  server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    switch (req.url) {
      case '/file':
        res.writeHead(200, { 'Content-Length': String(BODY.length) });
        res.end(BODY);
        break;
      case '/chunked':
        // Content-Length 無し
        res.writeHead(200);
        res.write(BODY.subarray(0, 2500));
        res.end(BODY.subarray(2500));
        break;
      case '/redirect-ok':
        res.writeHead(302, { Location: '/file' });
        res.end();
        break;
      case '/redirect-bad':
        // 許可していないホスト（localhost）へ
        res.writeHead(302, { Location: `http://localhost:${port}/file` });
        res.end();
        break;
      case '/loop':
        res.writeHead(302, { Location: '/loop' });
        res.end();
        break;
      case '/redirect-port':
        // 許可していないポートへ（つながる前に検査で止まる）
        res.writeHead(302, { Location: `http://127.0.0.1:${port === 65535 ? 1 : port + 1}/file` });
        res.end();
        break;
      case '/stall':
        // 一部だけ送って止まる（無通信）
        res.writeHead(200, { 'Content-Length': String(BODY.length) });
        res.write(BODY.subarray(0, 100));
        break;
      case '/stall-headers':
        // ヘッダも送らない
        break;
      case '/slow': {
        // 少しずつ送り続ける（無通信にはならないが終わらない）
        res.writeHead(200);
        const t = setInterval(() => res.write(BODY.subarray(0, 1)), 20);
        res.on('close', () => clearInterval(t));
        break;
      }
      default: {
        // /chain/N は N 回リダイレクトしてから本文を返す
        const m = /^\/chain\/(\d+)$/.exec(req.url ?? '');
        if (m) {
          const n = Number(m[1]);
          if (n === 0) {
            res.writeHead(200, { 'Content-Length': String(BODY.length) });
            res.end(BODY);
          } else {
            res.writeHead(302, { Location: `/chain/${n - 1}` });
            res.end();
          }
          break;
        }
        res.writeHead(404);
        res.end();
      }
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  otherBase = `http://localhost:${port}`;
});

after(() => {
  server.closeAllConnections();
  return new Promise<void>(r => server.close(() => r()));
});

const only127 = (h: string): boolean => h === '127.0.0.1';
const anyPort = (): boolean => true;
const opts = { isHostAllowed: only127, protocols: ['http:'] as const, isPortAllowed: anyPort, maxBytes: 10_000 };

test('hostAllowed: 一致かサブドメインだけ', () => {
  const allowed = ['tts-models.zenryoku.work', 'huggingface.co', 'hf.co'];
  assert.equal(hostAllowed('tts-models.zenryoku.work', allowed), true);
  assert.equal(hostAllowed('cdn-lfs.huggingface.co', allowed), true);
  assert.equal(hostAllowed('cas-bridge.xethub.HF.co', allowed), true);
  assert.equal(hostAllowed('evilhuggingface.co', allowed), false);
  assert.equal(hostAllowed('huggingface.co.evil.example', allowed), false);
  assert.equal(hostAllowed('zenryoku.work', allowed), false);
});

test('checkUrl: https だけ・資格情報なし・許可ホスト', () => {
  const allow = (h: string) => hostAllowed(h, ['hf.co']);
  assert.equal(checkUrl('https://hf.co/x.ztm', allow), null);
  assert.match(checkUrl('http://hf.co/x.ztm', allow)!, /https/);
  assert.match(checkUrl('https://user:pw@hf.co/x', allow)!, /credentials/);
  assert.match(checkUrl('https://example.com/x', allow)!, /not allowed/);
  assert.match(checkUrl('not a url', allow)!, /invalid/);
});

test('取得して sha256 を確かめる（Content-Length あり・なし、許可されたリダイレクト）', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    for (const path of ['/file', '/chunked', '/redirect-ok']) {
      const progress: number[] = [];
      const r = await downloadFile({ ...opts, url: base + path, dest: join(dir, 'm.ztm'), sha256: SHA, onProgress: n => progress.push(n) });
      assert.equal(r.sha256, SHA);
      assert.equal(r.bytes, BODY.length);
      assert.equal(r.partPath, join(dir, 'm.ztm.part'));
      assert.deepEqual(await readFile(r.partPath), BODY);
      assert.equal(progress.at(-1), BODY.length);
    }
  } finally {
    await cleanup();
  }
});

test('許可していないホストへのリダイレクト・多すぎるリダイレクト・許可していない最初のホスト', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const dest = join(dir, 'm.ztm');
    await assert.rejects(downloadFile({ ...opts, url: `${base}/redirect-bad`, dest }), (e: Error) => e instanceof DownloadError && /redirect to .*not allowed/.test(e.message));
    await assert.rejects(downloadFile({ ...opts, url: `${base}/loop`, dest }), /too many redirects/);
    await assert.rejects(downloadFile({ ...opts, url: `${otherBase}/file`, dest }), /not allowed/);
    await assert.rejects(downloadFile({ isHostAllowed: only127, maxBytes: 10_000, url: `${base}/file`, dest }), /https/);
    await assert.rejects(downloadFile({ ...opts, url: `${base}/missing`, dest }), /HTTP 404/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await cleanup();
  }
});

test('sha256 の不一致・上限超えは失敗し、.part を残さない', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const dest = join(dir, 'm.ztm');
    await assert.rejects(downloadFile({ ...opts, url: `${base}/file`, dest, sha256: 'f'.repeat(64) }), /sha256 mismatch/);
    await assert.rejects(downloadFile({ ...opts, maxBytes: 4000, url: `${base}/file`, dest }), /too large/);
    await assert.rejects(downloadFile({ ...opts, maxBytes: 4000, url: `${base}/chunked`, dest }), /too large/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await cleanup();
  }
});

const record = (url: string, sha256: string | null) => ({
  engine: 'zen-tts', id: 'm1', name: 'M1', source: { url, sha256 },
  status: 'pending' as const, bytes: null, progress: null, error: null, addedAt: '2026-01-01T00:00:00Z',
});

test('ModelDownloader: 取得 → 検査 → installed。sha256 を省略したら記録する', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const registry = await Registry.load(dir, () => '.fake');
    const engine = new FakeEngine();
    const d = new ModelDownloader({ registry, engines: new Map([[engine.id, engine]]), modelHosts: [], maxBytes: 10_000, timeoutMs: 10_000, isHostAllowed: only127, protocols: ['http:'], isPortAllowed: anyPort });
    await registry.add(record(`${base}/file`, null));
    await d.start(registry.get('zen-tts', 'm1')!);
    await assert.rejects(d.start(registry.get('zen-tts', 'm1')!), /already downloading/);
    await d.wait('zen-tts', 'm1');
    const rec = registry.get('zen-tts', 'm1')!;
    assert.equal(rec.status, 'installed', rec.error ?? '');
    assert.equal(rec.source.sha256, SHA);
    assert.equal(rec.bytes, BODY.length);
    assert.ok(existsSync(registry.modelPath('zen-tts', 'm1', '.fake')));
    assert.ok(!existsSync(`${registry.modelPath('zen-tts', 'm1', '.fake')}.part`));
    const saved = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'));
    assert.equal(saved.models[0].status, 'installed');
  } finally {
    await cleanup();
  }
});

test('ModelDownloader: エンジンで読めなければ error にしてファイルを消す', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const registry = await Registry.load(dir, () => '.fake');
    const engine = new FakeEngine();
    engine.verifyResult = new Error('not a ztm');
    const d = new ModelDownloader({ registry, engines: new Map([[engine.id, engine]]), modelHosts: [], maxBytes: 10_000, timeoutMs: 10_000, isHostAllowed: only127, protocols: ['http:'], isPortAllowed: anyPort });
    await registry.add(record(`${base}/file`, SHA));
    await d.start(registry.get('zen-tts', 'm1')!);
    await d.wait('zen-tts', 'm1');
    const rec = registry.get('zen-tts', 'm1')!;
    assert.equal(rec.status, 'error');
    assert.match(rec.error!, /not a ztm/);
    assert.deepEqual(await readdir(join(dir, 'models', 'zen-tts')), []);
  } finally {
    await cleanup();
  }
});

// ---- 取得の堅牢化（#20） ----

const downloader = (registry: Registry, engine: FakeEngine, o: { timeoutMs?: number; idleTimeoutMs?: number } = {}) =>
  new ModelDownloader({
    registry, engines: new Map([[engine.id, engine]]), modelHosts: [], maxBytes: 10_000, timeoutMs: o.timeoutMs ?? 10_000,
    idleTimeoutMs: o.idleTimeoutMs, isHostAllowed: only127, protocols: ['http:'], isPortAllowed: anyPort,
  });

const recordOf = (id: string, url: string) => ({ ...record(url, null), id, name: id });

/** fn の間に uncaughtException / unhandledRejection が起きないことを確かめる */
const noUncaught = async (fn: () => Promise<void>): Promise<void> => {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on('uncaughtException', on);
  process.on('unhandledRejection', on);
  try {
    await fn();
    // 遅れて出るものも拾う
    await new Promise(r => setTimeout(r, 50));
  } finally {
    process.off('uncaughtException', on);
    process.off('unhandledRejection', on);
  }
  assert.deepEqual(seen, []);
};

const isRoot = process.getuid?.() === 0;

test('書き込みエラー: 書けないディレクトリは失敗にし、落ちない・.part を残さない', { skip: isRoot && 'root では EACCES にならない' }, async () => {
  const { dir, cleanup } = await tempDir();
  const ro = join(dir, 'ro');
  await mkdir(ro);
  await chmod(ro, 0o500);
  const modelDir = join(dir, 'models', 'zen-tts');
  try {
    await noUncaught(async () => {
      for (const path of ['/file', '/chunked']) {
        await assert.rejects(downloadFile({ ...opts, url: base + path, dest: join(ro, 'm.ztm') }), (e: Error) => e instanceof DownloadError && /failed to write the file \(EACCES\)/.test(e.message));
      }
      // 書けない場所の下に作ろうとしたとき（mkdir の失敗）
      await assert.rejects(downloadFile({ ...opts, url: `${base}/file`, dest: join(ro, 'sub', 'm.ztm') }), /failed to write the file \(EACCES\)/);
    });
    assert.deepEqual(await readdir(ro), []);

    // ModelDownloader: error にしてメッセージを残し、active から外す
    const registry = await Registry.load(dir, () => '.fake');
    const engine = new FakeEngine();
    const d = downloader(registry, engine);
    await registry.add(record(`${base}/file`, null));
    await mkdir(modelDir, { recursive: true });
    await chmod(modelDir, 0o500);
    await noUncaught(async () => {
      await d.start(registry.get('zen-tts', 'm1')!);
      await d.wait('zen-tts', 'm1');
    });
    const rec = registry.get('zen-tts', 'm1')!;
    assert.equal(rec.status, 'error');
    assert.match(rec.error!, /failed to write the file \(EACCES\)/);
    assert.equal(d.isActive('zen-tts', 'm1'), false);
    assert.deepEqual(await readdir(modelDir), []);
  } finally {
    await chmod(ro, 0o700).catch(() => {});
    await chmod(modelDir, 0o700).catch(() => {});
    await cleanup();
  }
});

test('書き込みエラー: 書いている途中の ENOSPC も失敗にし、.part を残さない', { skip: !existsSync('/dev/full') && '/dev/full が無い' }, async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const dest = join(dir, 'm.ztm');
    await noUncaught(async () => {
      for (const path of ['/file', '/chunked']) {
        // .part を /dev/full へのリンクにする（書くと ENOSPC）
        await symlink('/dev/full', `${dest}.part`);
        await assert.rejects(downloadFile({ ...opts, url: base + path, dest }), /failed to write the file \(ENOSPC\)/);
        assert.deepEqual(await readdir(dir), []);
      }
    });
  } finally {
    await cleanup();
  }
});

test('取得先の制限: https・ポート 443 のみ（省略か明示の 443）', () => {
  const allow = (h: string) => hostAllowed(h, ['hf.co']);
  assert.equal(checkUrl('https://hf.co/x.ztm', allow), null);
  assert.equal(checkUrl('https://hf.co:443/x.ztm', allow), null);
  assert.match(checkUrl('https://hf.co:8443/x.ztm', allow)!, /port 8443 is not allowed/);
  assert.match(checkUrl('https://hf.co:80/x.ztm', allow)!, /port 80 is not allowed/);
  assert.match(checkUrl('http://hf.co:443/x.ztm', allow)!, /https/);
  // POST の検査は 400
  const d = new ModelDownloader({ registry: null as unknown as Registry, engines: new Map(), modelHosts: ['hf.co'], maxBytes: 1, timeoutMs: 1000 });
  d.validateUrl('https://hf.co:443/x.ztm');
  assert.throws(() => d.validateUrl('https://hf.co:8443/x.ztm'), (e: unknown) => e instanceof ApiError && e.status === 400 && /port 8443/.test(e.message));
});

test('取得先の制限: リダイレクト先のポート・ホストも検査し、リダイレクトは最大 5 回', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const dest = join(dir, 'm.ztm');
    const port = Number(new URL(base).port);
    const onlyThisPort = (p: number) => p === port;
    await assert.rejects(downloadFile({ ...opts, isPortAllowed: onlyThisPort, url: `${base}/redirect-port`, dest }), /redirect to .*port \d+ is not allowed/);
    await assert.rejects(downloadFile({ ...opts, isPortAllowed: onlyThisPort, url: `${base}/redirect-bad`, dest }), /redirect to .*not allowed/);
    assert.equal(MAX_REDIRECTS, 5);
    const r = await downloadFile({ ...opts, isPortAllowed: onlyThisPort, url: `${base}/chain/${MAX_REDIRECTS}`, dest, sha256: SHA });
    assert.equal(r.bytes, BODY.length);
    await assert.rejects(downloadFile({ ...opts, url: `${base}/chain/${MAX_REDIRECTS + 1}`, dest }), /too many redirects/);
  } finally {
    await cleanup();
  }
});

test('タイムアウト: 無通信・全体の上限を超えたら失敗にし、.part を残さない', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const dest = join(dir, 'm.ztm');
    await assert.rejects(downloadFile({ ...opts, idleTimeoutMs: 150, url: `${base}/stall`, dest }), (e: Error) => e instanceof DownloadError && /no data received/.test(e.message));
    await assert.rejects(downloadFile({ ...opts, idleTimeoutMs: 150, url: `${base}/stall-headers`, dest }), /no data received/);
    await assert.rejects(downloadFile({ ...opts, idleTimeoutMs: 1000, timeoutMs: 300, url: `${base}/slow`, dest }), (e: Error) => e instanceof DownloadError && /timed out/.test(e.message));
    assert.deepEqual(await readdir(dir), []);

    const registry = await Registry.load(dir, () => '.fake');
    const engine = new FakeEngine();
    const d = downloader(registry, engine, { timeoutMs: 300, idleTimeoutMs: 1000 });
    await registry.add(record(`${base}/slow`, null));
    await d.start(registry.get('zen-tts', 'm1')!);
    await d.wait('zen-tts', 'm1');
    const rec = registry.get('zen-tts', 'm1')!;
    assert.equal(rec.status, 'error');
    assert.match(rec.error!, /timed out/);
    assert.deepEqual(await readdir(join(dir, 'models', 'zen-tts')), []);
  } finally {
    await cleanup();
  }
});

test('件数の上限: 同時ダウンロードは 2 件まで（3 件目は 429・Retry-After 5）', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const registry = await Registry.load(dir, () => '.fake');
    const engine = new FakeEngine();
    const d = downloader(registry, engine);
    for (const id of ['a', 'b', 'c']) await registry.add(recordOf(id, `${base}/stall`));
    await d.start(registry.get('zen-tts', 'a')!);
    await d.start(registry.get('zen-tts', 'b')!);
    await assert.rejects(d.start(registry.get('zen-tts', 'c')!), (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryAfterSec === 5);
    assert.equal(registry.get('zen-tts', 'c')!.status, 'pending');
    await d.cancel('zen-tts', 'a');
    await d.start(registry.get('zen-tts', 'c')!);
    await d.cancelAll();
  } finally {
    await cleanup();
  }
});

test('削除: 取得中なら止めて .part が消えるのを待ってから消す。その間の取得は 409', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const registry = await Registry.load(dir, () => '.fake');
    const engine = new FakeEngine();
    const d = downloader(registry, engine);
    await registry.add(record(`${base}/stall`, null));
    const rec = registry.get('zen-tts', 'm1')!;
    await d.start(rec);
    const part = `${registry.modelPath('zen-tts', 'm1', '.fake')}.part`;
    while (!existsSync(part) || !registry.get('zen-tts', 'm1')!.progress?.receivedBytes) await new Promise(r => setTimeout(r, 10));
    await d.remove('zen-tts', 'm1', async () => {
      assert.equal(d.isActive('zen-tts', 'm1'), false);
      assert.equal(existsSync(part), false);
      assert.equal(d.isDeleting('zen-tts', 'm1'), true);
      await assert.rejects(d.start(rec), (e: unknown) => e instanceof ApiError && e.status === 409 && /being deleted/.test(e.message));
      await registry.remove('zen-tts', 'm1');
    });
    assert.equal(d.isDeleting('zen-tts', 'm1'), false);
    assert.equal(registry.get('zen-tts', 'm1'), undefined);
  } finally {
    await cleanup();
  }
});
