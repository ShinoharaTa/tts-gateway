import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const TOKEN = 'x'.repeat(32);
const load = (env: Record<string, string>) => loadConfig({ HOME: '/nonexistent', ...env }, () => {});

test('TTS_HOSTS の未指定アドレスは TTS_ALLOW_ANY_ADDRESS=1 のときだけ通る', () => {
  for (const host of ['0.0.0.0', '::']) {
    assert.deepEqual(load({ TTS_HOSTS: host, TTS_ALLOW_ANY_ADDRESS: '1', TTS_TOKEN: TOKEN }).hosts, [host]);
    assert.throws(() => load({ TTS_HOSTS: host, TTS_TOKEN: TOKEN }), /TTS_ALLOW_ANY_ADDRESS=1 when running in a container/);
    for (const v of ['true', 'yes', '0', '', ' 1']) {
      assert.throws(() => load({ TTS_HOSTS: host, TTS_ALLOW_ANY_ADDRESS: v, TTS_TOKEN: TOKEN }), /must not contain/, `${host} ${JSON.stringify(v)}`);
    }
  }
});

test('未指定アドレスはループバック以外なのでトークンが必須（TTS_ALLOW_NO_TOKEN=1 で opt-out）', () => {
  assert.throws(() => load({ TTS_HOSTS: '0.0.0.0', TTS_ALLOW_ANY_ADDRESS: '1' }), /set TTS_TOKEN/);
  const warns: string[] = [];
  loadConfig({ HOME: '/nonexistent', TTS_HOSTS: '0.0.0.0', TTS_ALLOW_ANY_ADDRESS: '1', TTS_ALLOW_NO_TOKEN: '1' }, m => warns.push(m));
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /no token/);
  assert.deepEqual(load({ TTS_HOSTS: '0.0.0.0', TTS_ALLOW_ANY_ADDRESS: '1', TTS_ADMIN_TOKEN: TOKEN }).hosts, ['0.0.0.0']);
});
