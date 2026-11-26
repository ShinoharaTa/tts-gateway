import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_DIR } from '../src/config.ts';
import { tempDir } from './helpers.ts';

/** 127.0.0.1 の 18700 番台で空いているポート */
const freePort = async (): Promise<number> => {
  for (let port = 18700; port < 18800; port++) {
    const ok = await new Promise<boolean>(resolve => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port in 18700-18799');
};

type Proc = { child: ChildProcess; stdout: string[]; stderr: string[]; exited: Promise<number | null>; waitLine: (re: RegExp) => Promise<string> };

/** node src/cli.ts serve を子プロセスで起動する（LOG_FORMAT=json） */
const serve = (dir: string, port: number): Proc => {
  const child = spawn(process.execPath, [join(PACKAGE_DIR, 'src', 'cli.ts'), 'serve'], {
    cwd: PACKAGE_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      TTS_DATA_DIR: join(dir, 'data'),
      TTS_CACHE_DIR: join(dir, 'cache'),
      TTS_HOSTS: '127.0.0.1',
      TTS_PORT: String(port),
      FFMPEG: 'false',
      LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const waiters: { re: RegExp; resolve: (l: string) => void }[] = [];
  const collect = (out: string[], stream: NodeJS.ReadableStream): void => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d: string) => {
      buf += d;
      const parts = buf.split('\n');
      buf = parts.pop()!;
      for (const l of parts) {
        out.push(l);
        for (const w of [...waiters]) {
          if (w.re.test(l)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(l);
          }
        }
      }
    });
  };
  collect(stdout, child.stdout!);
  collect(stderr, child.stderr!);
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const waitLine = (re: RegExp): Promise<string> => {
    const found = [...stdout, ...stderr].find(l => re.test(l));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}\nstdout:\n${stdout.join('\n')}\nstderr:\n${stderr.join('\n')}`)), 15_000);
      waiters.push({ re, resolve: l => (clearTimeout(t), resolve(l)) });
    });
  };
  return { child, stdout, stderr, exited, waitLine };
};

test('cli serve: /health が 200、SIGTERM で終了コード 0、stdout・stderr の各行が JSON', async () => {
  const { dir, cleanup } = await tempDir();
  const port = await freePort();
  const p = serve(dir, port);
  try {
    await p.waitLine(/listening on/);
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { status: string }).status, 'ok');
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
    assert.ok(p.stdout.length > 0);
    for (const l of [...p.stdout, ...p.stderr]) {
      const o = JSON.parse(l) as Record<string, unknown>;
      assert.equal(o.service, 'tts-gateway');
      assert.equal(typeof o.msg, 'string');
    }
    const starting = JSON.parse(p.stdout.find(l => /"msg":"starting"/.test(l))!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(starting).slice(4), ['version', 'node', 'dataDir', 'cacheDir', 'hosts', 'port', 'concurrency']);
    assert.ok(p.stdout.some(l => /"msg":"stopping","reason":"SIGTERM"/.test(l)));
  } finally {
    p.child.kill('SIGKILL');
    await p.exited;
    await cleanup();
  }
});

test('cli serve: 起動途中（starting の直後）に届いた SIGTERM でも終了コード 0', async () => {
  const { dir, cleanup } = await tempDir();
  const port = await freePort();
  const p = serve(dir, port);
  try {
    await p.waitLine(/"msg":"starting"/);
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
    assert.ok(p.stdout.some(l => /"msg":"stopping"/.test(l)));
  } finally {
    p.child.kill('SIGKILL');
    await p.exited;
    await cleanup();
  }
});
