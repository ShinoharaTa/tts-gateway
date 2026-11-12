/**
 * HTTP サーバー（node:http）。ルーティング、接続元の許可リスト、認証、JSON の入出力、設定画面の静的ファイル。
 *
 * - 許可リスト外の接続元は全パスで 403。認証は TTS_TOKEN があれば /healthz と設定画面の静的ファイル以外で必須、
 *   /v1/admin/* は TTS_ADMIN_TOKEN があればその値（無ければ TTS_TOKEN の規則）
 * - 本文は application/json だけ（ほかは 415）。CORS ヘッダは返さない
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { FfmpegProbe } from './audio/encode.ts';
import { AudioCache } from './cache.ts';
import { VERSION, type Config } from './config.ts';
import { createEngines, MODEL_EXTS, type EngineDeps } from './engines/index.ts';
import type { Engine } from './engines/types.ts';
import { ApiError, conflict, invalid, notFound } from './errors.ts';
import { loadCatalog, type CatalogModel } from './models/catalog.ts';
import { ModelDownloader } from './models/download.ts';
import { MODEL_ID_RE, Registry, type ModelRecord } from './models/registry.ts';
import { isAllowed } from './net.ts';
import { SynthQueue } from './queue.ts';
import { SettingsStore, validateSettingsPatch } from './settings.ts';
import { Synthesizer } from './synthesize.ts';
import { Dictionary, isAcronym, isReading } from './text/readings.ts';
import { checkKeys, checkObject, checkString, checkSurface } from './validate.ts';

export type App = {
  config: Config;
  engines: Map<string, Engine>;
  registry: Registry;
  settings: SettingsStore;
  cache: AudioCache;
  queue: SynthQueue;
  dictionary: Dictionary;
  catalog: CatalogModel[];
  downloader: ModelDownloader;
  synth: Synthesizer;
  /** ffmpeg の有無（30 秒たてば確かめ直す） */
  ffmpeg: FfmpegProbe;
  startedAt: number;
  close: () => Promise<void>;
};

export type AppOverrides = {
  /** テスト用: 偽のエンジン */
  engines?: (deps: EngineDeps) => Map<string, Engine>;
  /** テスト用: モデル取得のホスト判定と許可するスキーム */
  isHostAllowed?: (host: string) => boolean;
  protocols?: readonly string[];
};

export const createApp = async (config: Config, o: AppOverrides = {}): Promise<App> => {
  const settings = await SettingsStore.load(config.dataDir);
  const registry = await Registry.load(config.dataDir, engine => MODEL_EXTS[engine]);
  const engines = (o.engines ?? createEngines)({ registry, settings: () => settings.get(), concurrency: config.concurrency });
  const cache = new AudioCache({
    dir: config.cacheDir,
    maxBytes: () => settings.get().cacheMaxMB * 1024 * 1024,
    ttlMs: () => settings.get().cacheTtlDays * 86_400_000,
  });
  await cache.init();
  const queue = new SynthQueue({ concurrency: config.concurrency, max: config.queueMax });
  const dictionary = await Dictionary.load(join(config.packageDir, 'dict', 'readings.tsv'), join(config.dataDir, 'readings.tsv'));
  const catalog = loadCatalog(join(config.packageDir, 'catalog'));
  const downloader = new ModelDownloader({
    registry,
    engines,
    modelHosts: config.modelHosts,
    maxBytes: config.modelMaxBytes,
    isHostAllowed: o.isHostAllowed,
    protocols: o.protocols,
  });
  // ffmpeg が無くても起動は続ける（wav はそのまま返せる）
  const ffmpeg = new FfmpegProbe(config.ffmpeg);
  await ffmpeg.get();
  const synth = new Synthesizer({
    engines, registry, settings, cache, queue, dictionary,
    maxChars: config.maxChars, timeoutSec: config.timeoutSec, ffmpeg: config.ffmpeg, ffmpegProbe: ffmpeg,
  });
  settings.onChange(() => {
    void cache.evict().catch(e => console.error(`cache evict failed: ${(e as Error).message}`));
    for (const e of engines.values()) (e as Engine & { settingsChanged?: () => void }).settingsChanged?.();
  });
  // 作ってから TTL を過ぎたものを 1 時間ごとに消す
  const sweep = setInterval(() => void cache.evict().catch(() => {}), 3_600_000);
  sweep.unref();
  const close = async (): Promise<void> => {
    clearInterval(sweep);
    await downloader.cancelAll();
    await Promise.all([...engines.values()].map(e => e.close()));
  };
  return { config, engines, registry, settings, cache, queue, dictionary, catalog, downloader, synth, ffmpeg, startedAt: Date.now(), close };
};

// ---- 入出力 ----

/** 本文の上限 */
export const MAX_BODY_BYTES = 1024 * 1024;

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const data = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
};

const sendEmpty = (res: ServerResponse, status: number): void => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
  res.end();
};

const sendError = (res: ServerResponse, e: ApiError): void => {
  const headers: Record<string, string> = {};
  if (e.retryAfterSec !== undefined) headers['Retry-After'] = String(e.retryAfterSec);
  if (e.status === 401) headers['WWW-Authenticate'] = 'Bearer';
  sendJson(res, e.status, e.toJSON(), headers);
};

const isJson = (req: IncomingMessage): boolean => {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'application/json';
};

const hasBody = (req: IncomingMessage): boolean =>
  req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');

const readRaw = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw invalid(`request body must be at most ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** 本文を取る JSON。application/json でなければ 415 */
const readJson = async (req: IncomingMessage): Promise<unknown> => {
  if (!isJson(req)) throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  const raw = await readRaw(req);
  if (raw.length === 0) throw invalid('request body is empty');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid('request body is not valid JSON');
  }
};

/** 本文を取らないエンドポイント。本文があって JSON でなければ 415 */
const noBody = async (req: IncomingMessage): Promise<void> => {
  if (hasBody(req) && !isJson(req)) throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  if (hasBody(req)) await readRaw(req);
};

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

const tokenMatches = (req: IncomingMessage, token: string): boolean => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return !!m && timingSafeEqual(digest(m[1]!.trim()), digest(token));
};

const requireAuth = (req: IncomingMessage, config: Config, admin: boolean): void => {
  const token = admin && config.adminToken ? config.adminToken : config.token;
  if (!token) return;
  if (!tokenMatches(req, token)) throw new ApiError(401, 'unauthorized', 'missing or invalid bearer token');
};

// ---- 静的ファイル（設定画面） ----

const STATIC: Record<string, { file: string; type: string }> = {
  '/admin/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/admin.css': { file: 'admin.css', type: 'text/css; charset=utf-8' },
  '/admin/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
};

const CSP = "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const serveStatic = async (res: ServerResponse, config: Config, path: string, head: boolean): Promise<void> => {
  const s = STATIC[path]!;
  const data = await readFile(join(config.packageDir, 'public', 'admin', s.file));
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': s.type,
    'Content-Length': String(data.length),
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  });
  res.end(head ? undefined : data);
};

// ---- 各エンドポイント ----

const engineJson = (app: App, e: Engine): Record<string, unknown> => ({
  id: e.id,
  name: e.name,
  version: e.version,
  credit: e.credit,
  sampleRate: e.sampleRate,
  voices: e.voices(),
  ...e.describe(),
});

const enginesJson = (app: App): unknown => {
  const s = app.settings.get();
  return {
    default: { engine: s.defaultEngine, voice: s.defaultVoices[s.defaultEngine] ?? null },
    engines: [...app.engines.values()].map(e => engineJson(app, e)),
  };
};

const statusJson = async (app: App): Promise<unknown> => ({
  version: VERSION,
  uptimeSec: Math.floor((Date.now() - app.startedAt) / 1000),
  engines: [...app.engines.values()].map(e => e.status()),
  queue: app.queue.stats(),
  cache: app.cache.stats(),
  ffmpeg: await app.ffmpeg.get(),
  memory: { rssBytes: process.memoryUsage.rss() },
});

const MODEL_FIELDS = ['engine', 'id', 'name', 'url', 'sha256', 'catalog'] as const;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const MAX_NAME_CHARS = 64;

const addModel = async (app: App, raw: unknown): Promise<ModelRecord> => {
  const body = checkObject(raw, '');
  checkKeys(body, MODEL_FIELDS);
  if (body.engine === undefined) throw invalid('engine is required', 'engine');
  const engineId = checkString(body.engine, 'engine');
  const engine = app.engines.get(engineId);
  if (!engine) throw notFound(`engine ${engineId} not found`, 'engine');

  let rec: ModelRecord;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (body.catalog !== undefined) {
    for (const k of ['id', 'name', 'url', 'sha256'] as const) {
      if (body[k] !== undefined) throw invalid(`${k} cannot be used with catalog`, k);
    }
    const id = checkString(body.catalog, 'catalog');
    const c = app.catalog.find(m => m.engine === engineId && m.id === id);
    if (!c) throw notFound(`catalog model ${id} of ${engineId} not found`, 'catalog');
    rec = {
      engine: engineId, id: c.id, name: c.name, source: { url: c.url, sha256: c.sha256 },
      status: 'pending', bytes: null, progress: null, error: null, addedAt: now,
    };
  } else {
    if (body.id === undefined) throw invalid('id is required', 'id');
    const id = checkString(body.id, 'id');
    if (!MODEL_ID_RE.test(id)) throw invalid('id must match ^[a-z0-9][a-z0-9_-]{0,31}$', 'id');
    if (body.url === undefined) throw invalid('url is required', 'url');
    const url = checkString(body.url, 'url');
    const name = body.name === undefined ? id : checkString(body.name, 'name').trim();
    if (!name || [...name].length > MAX_NAME_CHARS) throw invalid(`name must be 1 to ${MAX_NAME_CHARS} characters`, 'name');
    let sha256: string | null = null;
    if (body.sha256 !== undefined) {
      sha256 = checkString(body.sha256, 'sha256');
      if (!SHA256_RE.test(sha256)) throw invalid('sha256 must be 64 hex characters', 'sha256');
      sha256 = sha256.toLowerCase();
    }
    rec = {
      engine: engineId, id, name, source: { url, sha256 },
      status: 'pending', bytes: null, progress: null, error: null, addedAt: now,
    };
  }
  app.downloader.validateUrl(rec.source.url, body.catalog !== undefined ? 'catalog' : 'url');
  if (app.registry.get(engineId, rec.id)) throw conflict(`model ${rec.id} of ${engineId} already exists`, 'id');
  await app.registry.add(rec);
  await app.downloader.start(rec);
  return rec;
};

const deleteModel = async (app: App, engineId: string, id: string): Promise<void> => {
  const engine = app.engines.get(engineId);
  const rec = app.registry.get(engineId, id);
  if (!engine || !rec) throw notFound(`model ${id} of ${engineId} not found`);
  if (app.settings.get().defaultVoices[engineId] === id) throw conflict(`model ${id} is the default voice of ${engineId}`);
  await app.downloader.cancel(engineId, id);
  const path = app.registry.modelPath(engineId, id, engine.modelExt);
  await rm(path, { force: true });
  await rm(`${path}.part`, { force: true });
  await app.registry.remove(engineId, id);
};

const decodeSegment = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw invalid('malformed URL encoding');
  }
};

const putReading = async (app: App, rawSurface: string, raw: unknown): Promise<void> => {
  const surface = checkSurface(rawSurface, 'surface');
  if (isAcronym(surface)) throw invalid('all-capital words of up to 5 characters are read by ZEN-TTS and cannot be registered', 'surface');
  const body = checkObject(raw, '');
  checkKeys(body, ['reading']);
  if (body.reading === undefined) throw invalid('reading is required', 'reading');
  const reading = checkString(body.reading, 'reading').trim();
  if (!isReading(reading)) throw invalid('reading must be katakana (with ー・ and spaces)', 'reading');
  await app.dictionary.set(surface, reading);
};

// ---- ルーティング ----

type Route = { method: string; re: RegExp; admin: boolean; auth: boolean; run: (app: App, req: IncomingMessage, res: ServerResponse, m: string[]) => Promise<void> };

const routes: Route[] = [
  {
    method: 'GET', re: /^\/healthz$/, admin: false, auth: false,
    run: async (_app, req, res) => {
      await noBody(req);
      sendJson(res, 200, { status: 'ok', version: VERSION });
    },
  },
  {
    method: 'GET', re: /^\/v1\/engines$/, admin: false, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, enginesJson(app));
    },
  },
  {
    method: 'POST', re: /^\/v1\/synthesize$/, admin: false, auth: true,
    run: async (app, req, res) => {
      const r = await app.synth.synthesize(await readJson(req));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': r.contentType,
        'Content-Length': String(r.audio.length),
        'Cache-Control': 'no-store',
        'X-Engine': r.engine.id,
        'X-Voice': r.voice,
        'X-Audio-Duration-Ms': String(r.durationMs),
        'X-Sample-Rate': String(r.sampleRate),
        'X-Cache': r.cache,
        'X-Synthesis-Ms': String(r.synthesisMs),
        'X-TTS-Credit': encodeURIComponent(r.engine.credit.en),
        ETag: `"${r.key}"`,
      });
      res.end(r.audio);
    },
  },
  {
    method: 'POST', re: /^\/v1\/normalize$/, admin: false, auth: true,
    run: async (app, req, res) => {
      sendJson(res, 200, app.synth.normalize(await readJson(req)));
    },
  },
  {
    method: 'GET', re: /^\/v1\/dictionary$/, admin: false, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, app.dictionary.toJSON());
    },
  },
  {
    method: 'GET', re: /^\/v1\/admin\/status$/, admin: true, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, await statusJson(app));
    },
  },
  {
    method: 'GET', re: /^\/v1\/admin\/settings$/, admin: true, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, app.settings.get());
    },
  },
  {
    method: 'PUT', re: /^\/v1\/admin\/settings$/, admin: true, auth: true,
    run: async (app, req, res) => {
      const patch = validateSettingsPatch(await readJson(req), {
        engineIds: [...app.engines.keys()],
        isInstalled: (engine, voice) => app.registry.get(engine, voice)?.status === 'installed',
      });
      sendJson(res, 200, await app.settings.update(patch));
    },
  },
  {
    method: 'GET', re: /^\/v1\/admin\/catalog$/, admin: true, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, { models: app.catalog.map(m => ({ ...m, registered: !!app.registry.get(m.engine, m.id) })) });
    },
  },
  {
    method: 'GET', re: /^\/v1\/admin\/models$/, admin: true, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, { models: app.registry.list() });
    },
  },
  {
    method: 'POST', re: /^\/v1\/admin\/models$/, admin: true, auth: true,
    run: async (app, req, res) => {
      sendJson(res, 202, await addModel(app, await readJson(req)));
    },
  },
  {
    method: 'POST', re: /^\/v1\/admin\/models\/([^/]+)\/([^/]+)\/download$/, admin: true, auth: true,
    run: async (app, req, res, m) => {
      await noBody(req);
      const [engineId, id] = [decodeSegment(m[1]!), decodeSegment(m[2]!)];
      const rec = app.registry.get(engineId, id);
      if (!rec) throw notFound(`model ${id} of ${engineId} not found`);
      if (rec.status !== 'pending' && rec.status !== 'error') throw conflict(`model ${id} is ${rec.status}`);
      await app.downloader.start(rec);
      sendJson(res, 202, rec);
    },
  },
  {
    method: 'DELETE', re: /^\/v1\/admin\/models\/([^/]+)\/([^/]+)$/, admin: true, auth: true,
    run: async (app, req, res, m) => {
      await noBody(req);
      await deleteModel(app, decodeSegment(m[1]!), decodeSegment(m[2]!));
      sendEmpty(res, 204);
    },
  },
  {
    method: 'PUT', re: /^\/v1\/admin\/dictionary\/([^/]+)$/, admin: true, auth: true,
    run: async (app, req, res, m) => {
      const surface = decodeSegment(m[1]!);
      await putReading(app, surface, await readJson(req));
      sendJson(res, 200, app.dictionary.toJSON());
    },
  },
  {
    method: 'DELETE', re: /^\/v1\/admin\/dictionary\/([^/]+)$/, admin: true, auth: true,
    run: async (app, req, res, m) => {
      await noBody(req);
      const surface = decodeSegment(m[1]!);
      if (!(await app.dictionary.delete(surface))) throw notFound(`${surface} is not in the user dictionary`);
      sendJson(res, 200, app.dictionary.toJSON());
    },
  },
  {
    method: 'DELETE', re: /^\/v1\/admin\/cache$/, admin: true, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      await app.cache.clear();
      sendEmpty(res, 204);
    },
  },
];

export const createHandler = (app: App): RequestListener => async (req, res) => {
  try {
    if (!isAllowed(req.socket.remoteAddress, app.config.allowCidrs)) throw new ApiError(403, 'forbidden', 'client address is not allowed');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';

    if ((method === 'GET' || method === 'HEAD') && path === '/admin') {
      res.writeHead(301, { ...SECURITY_HEADERS, Location: '/admin/' });
      res.end();
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && STATIC[path]) {
      await serveStatic(res, app.config, path, method === 'HEAD');
      return;
    }
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.auth) requireAuth(req, app.config, r.admin);
      await r.run(app, req, res, m);
      return;
    }
    throw notFound(`${method} ${path} not found`);
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (e instanceof ApiError) {
      if (e.status >= 500) console.error(`${req.method} ${req.url}: ${e.status} ${e.code} ${e.message}`);
      sendError(res, e);
    } else {
      console.error(`${req.method} ${req.url}: ${(e as Error)?.stack ?? e}`);
      sendError(res, new ApiError(500, 'internal_error', 'internal error'));
    }
  }
};
