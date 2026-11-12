import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { encode, FFMPEG_TIMEOUT_MS, FfmpegProbe, needsFfmpeg, probeFfmpeg } from '../src/audio/encode.ts';
import { ApiError } from '../src/errors.ts';
import { tempDir } from './helpers.ts';

const pcm = new Float32Array(800);

test('needsFfmpeg: エンジンのサンプルレートの wav だけ要らない', () => {
  assert.equal(needsFfmpeg('wav', 8000, 8000), false);
  assert.equal(needsFfmpeg('wav', 16000, 8000), true);
  assert.equal(needsFfmpeg('mp3', 8000, 8000), true);
});

test('encode: ffmpeg が起動できない（ENOENT / ENOTDIR / EACCES / 127）は 503、起動後の非 0 終了は 503 にしない', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const noExec = join(dir, 'ffmpeg');
    await writeFile(noExec, '#!/bin/sh\n');
    await chmod(noExec, 0o644);
    const exit127 = join(dir, 'exit127');
    await writeFile(exit127, '#!/bin/sh\nexit 127\n');
    await chmod(exit127, 0o755);
    // 通常ファイルの下のパスは spawn が同期的に throw する（ENOTDIR）
    for (const ffmpeg of [join(dir, 'missing'), join(noExec, 'ffmpeg'), noExec, exit127]) {
      await assert.rejects(encode(pcm, 8000, { format: 'mp3', sampleRate: 8000, ffmpeg }), (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 503);
        assert.equal(e.code, 'engine_unavailable');
        assert.equal(e.message, `ffmpeg is not available (${ffmpeg})`);
        return true;
      });
    }
    await assert.rejects(encode(pcm, 8000, { format: 'mp3', sampleRate: 8000, ffmpeg: 'false' }), (e: unknown) => {
      assert.ok(!(e instanceof ApiError));
      assert.match((e as Error).message, /^ffmpeg exited 1/);
      return true;
    });
    // wav でサンプルレートがそのままなら ffmpeg を起動しない
    const wav = await encode(pcm, 8000, { format: 'wav', sampleRate: 8000, ffmpeg: join(dir, 'missing') });
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  } finally {
    await cleanup();
  }
});

test('probeFfmpeg: 版を 1 行目から取る。無い・非 0 終了は available=false', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const fake = join(dir, 'ffmpeg');
    await writeFile(fake, '#!/bin/sh\necho "ffmpeg version 7.0.2-static https://example.com Copyright (c) 2000-2024"\necho "built with gcc"\n');
    await chmod(fake, 0o755);
    assert.deepEqual(await probeFfmpeg(fake), { available: true, path: fake, version: '7.0.2-static', reason: null });
    const odd = join(dir, 'odd');
    await writeFile(odd, '#!/bin/sh\necho "something else"\n');
    await chmod(odd, 0o755);
    assert.deepEqual(await probeFfmpeg(odd), { available: true, path: odd, version: null, reason: null });
    const missing = join(dir, 'missing');
    assert.deepEqual(await probeFfmpeg(missing), { available: false, path: missing, version: null, reason: `spawn ${missing} ENOENT` });
    assert.deepEqual(await probeFfmpeg('false'), { available: false, path: 'false', version: null, reason: 'exited 1' });
    // spawn の同期 throw（ENOTDIR）も reject せず available=false
    const notDir = join(fake, 'ffmpeg');
    const s = await probeFfmpeg(notDir);
    assert.equal(s.available, false);
    assert.equal(s.version, null);
    assert.match(s.reason!, /ENOTDIR/);
  } finally {
    await cleanup();
  }
});

test('FfmpegProbe: 30 秒以内は前回の結果、過ぎたら probe し直す。同時の get は 1 本の probe にまとめる', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    let now = 1_000_000;
    const fake = join(dir, 'ffmpeg');
    const log = join(dir, 'runs');
    const probe = new FfmpegProbe(fake, { now: () => now });
    assert.equal((await probe.get()).available, false);
    // 入れても 30 秒たつまでは前回の結果
    await writeFile(fake, `#!/bin/sh\necho run >> '${log}'\necho "ffmpeg version 7.1"\n`);
    await chmod(fake, 0o755);
    now += 29_999;
    assert.equal((await probe.get()).available, false);
    now += 1;
    const all = await Promise.all([probe.get(), probe.get(), probe.get()]);
    assert.ok(all.every(s => s.available && s.version === '7.1'));
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).length, 1);
    // 直後は probe しない
    await probe.get();
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).length, 1);
  } finally {
    await cleanup();
  }
});

/** 出力（最後の引数）を書きかけてからハングする偽の ffmpeg。exec でなければ sh の子の sleep が stdio を握ったまま残る */
const hangingFfmpeg = async (dir: string, exec: boolean): Promise<string> => {
  const fake = join(dir, exec ? 'hang-exec' : 'hang-child');
  await writeFile(fake, `#!/bin/sh\nfor a; do out="$a"; done\necho partial > "$out"\n${exec ? 'exec sleep 30' : 'sleep 3'}\n`);
  await chmod(fake, 0o755);
  return fake;
};

/** encode の一時ディレクトリを dir の下に作らせる（os.tmpdir() は TMPDIR を見る） */
const withTmpdir = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
};

const encDirs = async (dir: string): Promise<string[]> => (await readdir(dir)).filter(n => n.startsWith('tts-gateway-enc-'));

test('encode: ハングした ffmpeg は abort で kill し、signal.reason で失敗する。一時ディレクトリは残らない', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const tmp = join(dir, 'tmp');
    await mkdir(tmp);
    for (const exec of [true, false]) {
      const ffmpeg = await hangingFfmpeg(dir, exec);
      const ac = new AbortController();
      const reason = new Error('client disconnected');
      const started = Date.now();
      const p = withTmpdir(tmp, () => encode(pcm, 8000, { format: 'mp3', sampleRate: 8000, ffmpeg, signal: ac.signal }));
      await new Promise(r => setTimeout(r, 200));
      assert.equal((await encDirs(tmp)).length, 1);
      ac.abort(reason);
      await assert.rejects(p, (e: unknown) => e === reason);
      // 孫プロセスが stdio を握っていても待たない
      assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
      assert.deepEqual(await encDirs(tmp), []);
    }
    // 始める前に abort 済みなら起動しない
    const ac = new AbortController();
    ac.abort(new Error('already'));
    await assert.rejects(
      withTmpdir(tmp, () => encode(pcm, 8000, { format: 'mp3', sampleRate: 8000, ffmpeg: join(dir, 'missing'), signal: ac.signal })),
      /already/,
    );
    assert.deepEqual(await encDirs(tmp), []);
  } finally {
    await cleanup();
  }
});

test('encode: タイムアウトを超えた ffmpeg は kill して 503 engine_unavailable（timed out）。成功・失敗でも一時ディレクトリは残らない', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const tmp = join(dir, 'tmp');
    await mkdir(tmp);
    assert.equal(FFMPEG_TIMEOUT_MS, 30_000);
    const ffmpeg = await hangingFfmpeg(dir, true);
    await assert.rejects(
      withTmpdir(tmp, () => encode(pcm, 8000, { format: 'opus', sampleRate: 8000, ffmpeg, timeoutMs: 300 })),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 503);
        assert.equal(e.code, 'engine_unavailable');
        assert.match(e.message, /timed out/);
        return true;
      },
    );
    assert.deepEqual(await encDirs(tmp), []);
    // 成功（入力を読み、出力を書いて 0 で終わる）
    const ok = join(dir, 'ok');
    await writeFile(ok, '#!/bin/sh\nfor a; do out="$a"; done\ncat > /dev/null\necho done > "$out"\n');
    await chmod(ok, 0o755);
    const out = await withTmpdir(tmp, () => encode(pcm, 8000, { format: 'mp3', sampleRate: 8000, ffmpeg: ok, timeoutMs: 5000 }));
    assert.equal(out.toString(), 'done\n');
    assert.deepEqual(await encDirs(tmp), []);
    // 失敗（非 0 終了）
    await assert.rejects(withTmpdir(tmp, () => encode(pcm, 8000, { format: 'mp3', sampleRate: 8000, ffmpeg: 'false' })), /ffmpeg exited 1/);
    assert.deepEqual(await encDirs(tmp), []);
  } finally {
    await cleanup();
  }
});
