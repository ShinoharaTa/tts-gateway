/**
 * tts-gateway の CLI。
 *
 *   node src/cli.ts serve                 サーバーを起動する
 *   node src/cli.ts models fetch [id...]  カタログ（catalog/zen-tts.json）の声を登録して取得する（id 省略で全部）
 *   node src/cli.ts models list           登録済みモデルと状態
 *
 * models fetch はサーバーと同じ models.json を書くので、サーバーを止めてから使う（動いているときは設定画面から追加する）。
 */
import { loadConfig } from './config.ts';
import { listenAll } from './net.ts';
import { createApp, createHandler } from './server.ts';

const USAGE = `usage:
  node src/cli.ts serve
  node src/cli.ts models fetch [id...]
  node src/cli.ts models list`;

const serve = async (): Promise<void> => {
  const config = loadConfig();
  const app = await createApp(config);
  const listening = await listenAll(createHandler(app), config.hosts, config.port);
  console.error(`tts-gateway: data ${config.dataDir}, cache ${config.cacheDir}`);
  const ffmpeg = await app.ffmpeg.get();
  if (!ffmpeg.available)
    console.error(`ffmpeg is not available (${ffmpeg.path}: ${ffmpeg.reason}): only wav at the engine's sample rate can be returned`);
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.error(`${signal}: stopping`);
    await listening.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
};

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;

const fetchModels = async (ids: string[]): Promise<void> => {
  const config = loadConfig();
  const app = await createApp(config);
  const engine = 'zen-tts';
  const catalog = app.catalog.filter(m => m.engine === engine);
  const unknown = ids.filter(id => !catalog.some(m => m.id === id));
  if (unknown.length) {
    console.error(`not in catalog: ${unknown.join(', ')} (available: ${catalog.map(m => m.id).join(', ')})`);
    await app.close();
    process.exit(2);
  }
  let failed = false;
  for (const c of catalog.filter(m => ids.length === 0 || ids.includes(m.id))) {
    let rec = app.registry.get(engine, c.id);
    if (rec?.status === 'installed') {
      console.log(`${c.id}: installed`);
      continue;
    }
    if (!rec) {
      rec = {
        engine, id: c.id, name: c.name, source: { url: c.url, sha256: c.sha256 },
        status: 'pending', bytes: null, progress: null, error: null, addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      await app.registry.add(rec);
    }
    console.log(`${c.id}: ${c.url}`);
    let last = 0;
    const timer = setInterval(() => {
      const p = app.registry.get(engine, c.id)?.progress;
      if (p && p.receivedBytes !== last) {
        last = p.receivedBytes;
        console.log(`  ${mb(p.receivedBytes)}${p.totalBytes ? ` / ${mb(p.totalBytes)}` : ''}`);
      }
    }, 2000);
    await app.downloader.start(rec);
    await app.downloader.wait(engine, c.id);
    clearInterval(timer);
    const done = app.registry.get(engine, c.id)!;
    if (done.status === 'installed') console.log(`${c.id}: installed (${mb(done.bytes ?? 0)}, sha256 ${done.source.sha256})`);
    else {
      failed = true;
      console.error(`${c.id}: ${done.status}: ${done.error}`);
    }
  }
  await app.close();
  process.exit(failed ? 1 : 0);
};

const listModels = async (): Promise<void> => {
  const config = loadConfig();
  const app = await createApp(config);
  const models = app.registry.list();
  if (models.length === 0) console.log('(no models)');
  for (const m of models) console.log(`${m.engine}\t${m.id}\t${m.status}\t${m.name}${m.error ? `\t${m.error}` : ''}`);
  await app.close();
};

const [cmd, sub, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'serve') await serve();
  else if (cmd === 'models' && sub === 'fetch') await fetchModels(rest);
  else if (cmd === 'models' && sub === 'list') await listModels();
  else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
