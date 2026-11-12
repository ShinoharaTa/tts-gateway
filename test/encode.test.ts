import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { encode, needsFfmpeg, probeFfmpeg } from '../src/audio/encode.ts';
import { ApiError } from '../src/errors.ts';
import { tempDir } from './helpers.ts';

const pcm = new Float32Array(800);

test('needsFfmpeg: エンジンのサンプルレートの wav だけ要らない', () => {
  assert.equal(needsFfmpeg('wav', 8000, 8000), false);
  assert.equal(needsFfmpeg('wav', 16000, 8000), true);
  assert.equal(needsFfmpeg('mp3', 8000, 8000), true);
});

test('encode: ffmpeg が起動できない（ENOENT / EACCES）は 503、起動後の非 0 終了は 503 にしない', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const noExec = join(dir, 'ffmpeg');
    await writeFile(noExec, '#!/bin/sh\n');
    await chmod(noExec, 0o644);
    for (const ffmpeg of [join(dir, 'missing'), noExec]) {
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
    assert.deepEqual(await probeFfmpeg(fake), { available: true, path: fake, version: '7.0.2-static' });
    const odd = join(dir, 'odd');
    await writeFile(odd, '#!/bin/sh\necho "something else"\n');
    await chmod(odd, 0o755);
    assert.deepEqual(await probeFfmpeg(odd), { available: true, path: odd, version: null });
    assert.deepEqual(await probeFfmpeg(join(dir, 'missing')), { available: false, path: join(dir, 'missing'), version: null });
    assert.deepEqual(await probeFfmpeg('false'), { available: false, path: 'false', version: null });
  } finally {
    await cleanup();
  }
});
