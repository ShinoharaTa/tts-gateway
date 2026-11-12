/**
 * engine.test.ts 用の偽の合成プロセス（src/engines/zen-tts/child.ts と同じやりとり。zen-tts は読まない）。
 *
 * - load: モデルのファイル名（拡張子を除く）を声とする。声が slow で始まれば ready を 300ms 遅らせ、bad で始まれば fatal
 * - speak: 声の文字コードを並べた Float32Array を返す（どの声で合成したかを親で確かめる）
 */
import { basename, extname } from 'node:path';

type Msg = { type: 'load'; modelPath: string } | { type: 'speak'; id: number; text: string };

let voice: string | null = null;

process.on('message', (m: Msg) => {
  if (m.type === 'load') {
    const v = basename(m.modelPath, extname(m.modelPath));
    if (v.startsWith('bad')) {
      process.send?.({ type: 'fatal', message: 'bad model' });
      return;
    }
    setTimeout(
      () => {
        voice = v;
        process.send?.({ type: 'ready', kernel: 'fake', voice: v, version: '0.0.0' });
      },
      v.startsWith('slow') ? 300 : 0,
    );
  } else if (m.type === 'speak') {
    if (!voice) {
      process.send?.({ type: 'error', id: m.id, message: 'model is not loaded' });
      return;
    }
    const pcm = Float32Array.from([...voice].map(c => c.charCodeAt(0)));
    process.send?.({ type: 'result', id: m.id, pcm, sampleRate: 44100 });
  }
});

process.on('disconnect', () => process.exit(0));
