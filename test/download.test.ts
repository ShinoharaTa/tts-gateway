import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkUrl, DownloadError, downloadFile, hostAllowed, ModelDownloader } from '../src/models/download.ts';
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
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  otherBase = `http://localhost:${port}`;
});

after(() => new Promise<void>(r => server.close(() => r())));

const only127 = (h: string): boolean => h === '127.0.0.1';
const opts = { isHostAllowed: only127, protocols: ['http:'] as const, maxBytes: 10_000 };

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
    const d = new ModelDownloader({ registry, engines: new Map([[engine.id, engine]]), modelHosts: [], maxBytes: 10_000, isHostAllowed: only127, protocols: ['http:'] });
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
    const d = new ModelDownloader({ registry, engines: new Map([[engine.id, engine]]), modelHosts: [], maxBytes: 10_000, isHostAllowed: only127, protocols: ['http:'] });
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
