import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { isAllowed, parseCidr, parseIp } from '../src/net.ts';

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
  const c = loadConfig({ HOME: '/nonexistent-home', TTS_HOSTS: '127.0.0.1, 192.0.2.10' });
  assert.deepEqual(c.hosts, ['127.0.0.1', '192.0.2.10']);
  assert.equal(c.port, 8710);
  assert.equal(c.dataDir, '/nonexistent-home/.local/share/tts-gateway');
  assert.equal(c.cacheDir, '/nonexistent-home/.cache/tts-gateway/audio');
  assert.equal(c.modelMaxBytes, 512 * 1024 * 1024);
});
