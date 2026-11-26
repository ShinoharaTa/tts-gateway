import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { configureLog, log, setLogSink } from '../src/log.ts';

type Line = { stream: 'stdout' | 'stderr'; line: string };

const capture = (env: Record<string, string> = {}): Line[] => {
  const lines: Line[] = [];
  configureLog(env);
  setLogSink((stream, line) => lines.push({ stream, line }));
  return lines;
};

afterEach(() => {
  setLogSink(null);
  configureLog({});
});

test('json: time・level・service・env・msg・fields の順、Error は name・message・stack', () => {
  const lines = capture({ LOG_FORMAT: 'json', APP_ENV: 'production', SERVICE_NAME: 'tts-test' });
  const err = new TypeError('boom');
  log.info('hello', { a: 1, b: 'x y', err });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!.line, /\n/);
  const o = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(o), ['time', 'level', 'service', 'env', 'msg', 'a', 'b', 'err']);
  assert.match(o.time as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(o.level, 'info');
  assert.equal(o.service, 'tts-test');
  assert.equal(o.env, 'production');
  assert.equal(o.msg, 'hello');
  assert.deepEqual(o.err, { name: 'TypeError', message: 'boom', stack: err.stack });
});

test('json: APP_ENV が空なら env を出さない。fields は予約キーを上書きしない', () => {
  const lines = capture({ LOG_FORMAT: 'json' });
  log.warn('m', { time: 'x', level: 'x', service: 'x', env: 'x', msg: 'x', ok: true });
  const o = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(o), ['time', 'level', 'service', 'msg', 'ok']);
  assert.equal(o.level, 'warn');
  assert.equal(o.service, 'tts-gateway');
  assert.equal(o.msg, 'm');
  assert.notEqual(o.time, 'x');
});

test('text: msg key=value、空白を含む文字列は JSON、Error は stack を次の行以降に。時刻・レベルは付けない', () => {
  const lines = capture();
  log.info('request', { id: 'abc', path: '/a b', n: 3, hosts: ['127.0.0.1'], skip: undefined });
  assert.equal(lines[0]!.line, 'request id=abc path="/a b" n=3 hosts=["127.0.0.1"]');
  const err = new Error('bad');
  log.error('internal error', { method: 'GET', err });
  assert.equal(lines[1]!.line, `internal error method=GET\n${err.stack}`);
  log.info('plain');
  assert.equal(lines[2]!.line, 'plain');
});

test('level 未満は出さない。debug・info は stdout、warn・error は stderr', () => {
  let lines = capture();
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(lines, [
    { stream: 'stdout', line: 'i' },
    { stream: 'stderr', line: 'w' },
    { stream: 'stderr', line: 'e' },
  ]);
  lines = capture({ LOG_LEVEL: 'debug' });
  log.debug('d');
  assert.deepEqual(lines, [{ stream: 'stdout', line: 'd' }]);
  lines = capture({ LOG_LEVEL: 'error' });
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(lines, [{ stream: 'stderr', line: 'e' }]);
});

test('不正な LOG_LEVEL・LOG_FORMAT は throw', () => {
  assert.throws(() => configureLog({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
  assert.throws(() => configureLog({ LOG_LEVEL: 'INFO' }), /LOG_LEVEL/);
  assert.throws(() => configureLog({ LOG_FORMAT: 'logfmt' }), /LOG_FORMAT/);
});
