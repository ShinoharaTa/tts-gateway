import assert from 'node:assert/strict';
import { request, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { isAllowed, isLoopback, isUnspecified, listenAll, parseCidr, parseIp } from '../src/net.ts';

const cidrs = (s: string) => s.split(',').map(c => parseCidr(c)!);

test('parseIp: IPv4・IPv6・IPv4-mapped', () => {
  assert.deepEqual(parseIp('192.0.2.10'), { family: 4, bytes: Uint8Array.from([192, 0, 2, 10]) });
  assert.equal(parseIp('::1')?.family, 6);
  assert.deepEqual(parseIp('::ffff:192.0.2.10'), { family: 4, bytes: Uint8Array.from([192, 0, 2, 10]) });
  assert.deepEqual(parseIp('::ffff:c000:20a'), { family: 4, bytes: Uint8Array.from([192, 0, 2, 10]) });
  assert.equal(parseIp('2001:db8::1')?.bytes[15], 1);
  assert.equal(parseIp('fe80::1%eth0')?.family, 6);
  for (const bad of ['', '1.2.3', '256.0.0.1', '1.2.3.4.5', 'abc', '1::2::3', '12345::', '::g']) assert.equal(parseIp(bad), null, bad);
});

test('parseCidr: 不正な形は null', () => {
  assert.equal(parseCidr('192.0.2.0/33'), null);
  assert.equal(parseCidr('192.0.2.0/x'), null);
  assert.equal(parseCidr('::1/129'), null);
  assert.equal(parseCidr('192.0.2.0/24/1'), null);
  assert.deepEqual(parseCidr('192.0.2.10')?.prefix, 32);
});

test('isAllowed: 既定の 127.0.0.1/32,::1/128', () => {
  const c = cidrs('127.0.0.1/32,::1/128');
  assert.equal(isAllowed('127.0.0.1', c), true);
  assert.equal(isAllowed('::1', c), true);
  assert.equal(isAllowed('::ffff:127.0.0.1', c), true);
  assert.equal(isAllowed('127.0.0.2', c), false);
  assert.equal(isAllowed('192.0.2.10', c), false);
  assert.equal(isAllowed(undefined, c), false);
  assert.equal(isAllowed('garbage', c), false);
});

test('isAllowed: 範囲の境界', () => {
  const c = cidrs('198.18.0.0/15,2001:db8::/32,192.0.2.128/25');
  assert.equal(isAllowed('198.18.0.1', c), true);
  assert.equal(isAllowed('198.19.255.255', c), true);
  assert.equal(isAllowed('198.20.0.0', c), false);
  assert.equal(isAllowed('::ffff:198.19.1.1', c), true);
  assert.equal(isAllowed('2001:db8:ffff::1', c), true);
  assert.equal(isAllowed('2001:db9::1', c), false);
  assert.equal(isAllowed('192.0.2.127', c), false);
  assert.equal(isAllowed('192.0.2.200', c), true);
  assert.equal(isAllowed('0.0.0.0', cidrs('0.0.0.0/0')), true);
});

test('IPv4-mapped の CIDR は v4 の範囲として扱う', () => {
  const c = cidrs('::ffff:192.0.2.0/120');
  assert.equal(isAllowed('192.0.2.5', c), true);
  assert.equal(isAllowed('192.0.3.5', c), false);
});

test('config: 0.0.0.0・:: は起動時エラー、CIDR の誤りもエラー', () => {
  assert.throws(() => loadConfig({ TTS_HOSTS: '127.0.0.1,0.0.0.0' }), /0\.0\.0\.0/);
  assert.throws(() => loadConfig({ TTS_HOSTS: '::' }), /::/);
  assert.throws(() => loadConfig({ TTS_ALLOW_CIDRS: '192.0.2.0/99' }), /CIDR/);
  assert.throws(() => loadConfig({ TTS_CONCURRENCY: '3' }), /TTS_CONCURRENCY/);
  assert.throws(() => loadConfig({ TTS_AFFINITY_MAX_WAIT_MS: '60001' }), /TTS_AFFINITY_MAX_WAIT_MS/);
  assert.throws(() => loadConfig({ TTS_AFFINITY_MAX_WAIT_MS: '1.5' }), /TTS_AFFINITY_MAX_WAIT_MS/);
  assert.equal(loadConfig({ TTS_AFFINITY_MAX_WAIT_MS: '0' }).affinityMaxWaitMs, 0);
  const c = loadConfig({ HOME: '/nonexistent-home', TTS_HOSTS: '127.0.0.1, 192.0.2.10', TTS_TOKEN: 'x'.repeat(32) });
  assert.deepEqual(c.hosts, ['127.0.0.1', '192.0.2.10']);
  assert.equal(c.port, 8710);
  assert.equal(c.dataDir, '/nonexistent-home/.local/share/tts-gateway');
  assert.equal(c.cacheDir, '/nonexistent-home/.cache/tts-gateway/audio');
  assert.equal(c.modelMaxBytes, 512 * 1024 * 1024);
  assert.equal(c.affinityMaxWaitMs, 5000);
});

/** loadConfig の警告を集める */
const load = (env: Record<string, string>): { warnings: string[]; config: ReturnType<typeof loadConfig> } => {
  const warnings: string[] = [];
  const config = loadConfig({ HOME: '/nonexistent-home', ...env }, m => warnings.push(m));
  return { warnings, config };
};

const TOKEN = 'a'.repeat(32);

test('config: TTS_HOSTS は IP リテラルだけ、未指定アドレスは解析して拒否', () => {
  for (const h of ['localhost', 'tts.example.com', '[::1]', '0', '127.1', '192.0.2.10:8710']) {
    assert.throws(() => load({ TTS_HOSTS: h, TTS_TOKEN: TOKEN }), /IP addresses only/, h);
  }
  for (const h of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '0::0']) {
    assert.throws(() => load({ TTS_HOSTS: h, TTS_TOKEN: TOKEN }), /must not contain/, h);
  }
  assert.deepEqual(load({ TTS_HOSTS: '::1,127.0.0.1' }).config.hosts, ['::1', '127.0.0.1']);
  assert.equal(isUnspecified('::ffff:0.0.0.0'), true);
  assert.equal(isUnspecified('::1'), false);
});

test('config: ループバック以外で待ち受けるならトークンが必須（TTS_ALLOW_NO_TOKEN=1 で警告だけ）', () => {
  assert.throws(() => load({ TTS_HOSTS: '127.0.0.1,192.0.2.10' }), /TTS_TOKEN/);
  assert.throws(() => load({ TTS_HOSTS: '100.64.0.1', TTS_ALLOW_NO_TOKEN: 'yes' }), /TTS_ALLOW_NO_TOKEN=1/);
  let r = load({ TTS_HOSTS: '192.0.2.10', TTS_ALLOW_NO_TOKEN: '1' });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /no token/);
  // どちらか片方があればよい
  assert.deepEqual(load({ TTS_HOSTS: '192.0.2.10', TTS_TOKEN: TOKEN }).warnings, []);
  assert.deepEqual(load({ TTS_HOSTS: '192.0.2.10', TTS_ADMIN_TOKEN: TOKEN }).warnings, []);
  // ループバックだけならトークン無しで起動できる
  for (const h of ['127.0.0.1', '::1', '127.0.0.2', '::ffff:127.0.0.1']) assert.deepEqual(load({ TTS_HOSTS: h }).warnings, [], h);
  assert.equal(isLoopback('127.255.0.1'), true);
  assert.equal(isLoopback('::2'), false);
});

test('config: change-me で始まるトークンは起動エラー、16 文字未満は警告', () => {
  assert.throws(() => load({ TTS_TOKEN: 'change-me-api-token' }), /TTS_TOKEN.*example value/);
  assert.throws(() => load({ TTS_ADMIN_TOKEN: 'change-me' }), /TTS_ADMIN_TOKEN/);
  const r = load({ TTS_TOKEN: 'short', TTS_ADMIN_TOKEN: TOKEN });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /TTS_TOKEN is shorter than 16/);
});

test('config: TTS_ALLOW_CIDRS の /0 は警告、TTS_ALLOWED_HOSTS は小文字、TTS_MAX_CONNECTIONS は 1〜1024', () => {
  const r = load({ TTS_ALLOW_CIDRS: '127.0.0.1/32,0.0.0.0/0,::/0' });
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0]!, /0\.0\.0\.0\/0/);
  assert.match(r.warnings[1]!, /::\/0/);
  assert.deepEqual(load({ TTS_ALLOWED_HOSTS: 'TTS.Example.com, myhost.tailnet.example' }).config.allowedHosts, ['tts.example.com', 'myhost.tailnet.example']);
  assert.equal(load({}).config.maxConnections, 64);
  assert.equal(load({ TTS_MAX_CONNECTIONS: '1024' }).config.maxConnections, 1024);
  assert.throws(() => load({ TTS_MAX_CONNECTIONS: '0' }), /TTS_MAX_CONNECTIONS/);
  assert.throws(() => load({ TTS_MAX_CONNECTIONS: '1025' }), /TTS_MAX_CONNECTIONS/);
});

test('listenAll: 接続の上限・タイムアウト、許可外の接続元は connection の時点で閉じる', async () => {
  const handler = (_req: unknown, res: { end: (s: string) => void }) => res.end('ok');
  const get = (port: number) =>
    new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });

  let l = await listenAll(handler as never, ['127.0.0.1'], 0, { allowCidrs: [parseCidr('127.0.0.1/32')!], maxConnections: 7, log: () => {} });
  try {
    const s = l.servers[0]!;
    assert.equal(s.maxConnections, 7);
    assert.equal(s.headersTimeout, 10_000);
    assert.equal(s.requestTimeout, 30_000);
    assert.equal(s.keepAliveTimeout, 5_000);
    assert.equal(await get((s.address() as AddressInfo).port), 'ok');
  } finally {
    await l.close();
  }

  let reached = false;
  l = await listenAll(() => (reached = true), ['127.0.0.1'], 0, { allowCidrs: [parseCidr('192.0.2.0/24')!], log: () => {} });
  try {
    await assert.rejects(get((l.servers[0]!.address() as AddressInfo).port), /ECONNRESET|socket hang up/);
    assert.equal(reached, false);
  } finally {
    await l.close();
  }
});

test('listenAll: EADDRNOTAVAIL の再試行中に別のエラーが起きたら log して onFatal', async () => {
  const codes = ['EADDRNOTAVAIL', 'EADDRINUSE'];
  const orig = Server.prototype.listen;
  // listen を差し替えて、1 回目は EADDRNOTAVAIL、2 回目は EADDRINUSE にする
  Server.prototype.listen = function (this: Server) {
    const code = codes.shift()!;
    process.nextTick(() => this.emit('error', Object.assign(new Error(`listen ${code}`), { code })));
    return this;
  } as never;
  const logs: string[] = [];
  try {
    const fatal = new Promise<Error>(resolve => {
      void listenAll(() => {}, ['192.0.2.1'], 8, { log: m => logs.push(m), retryMs: 10, onFatal: resolve }).then(l => {
        // 起動自体は再試行に入った時点で終わる
        assert.equal(l.servers.length, 1);
      });
    });
    const e = (await fatal) as NodeJS.ErrnoException;
    assert.equal(e.code, 'EADDRINUSE');
    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /not available yet/);
    assert.match(logs[1]!, /EADDRINUSE/);
  } finally {
    Server.prototype.listen = orig;
  }
});
