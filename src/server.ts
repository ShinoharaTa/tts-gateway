/**
 * HTTP サーバー（node:http）。ルーティング、接続元の許可リスト、認証、JSON の入出力、設定画面の静的ファイル。
 *
 * - 許可リスト外の接続元は全パスで 403。Host が TTS_HOSTS:TTS_PORT・localhost:TTS_PORT・TTS_ALLOWED_HOSTS 以外なら 421、
 *   GET / HEAD / OPTIONS 以外で Origin の host が同じ許可に入らなければ 403（DNS rebinding・CSRF 対策）
 * - 認証は TTS_TOKEN があれば /healthz・/health*・設定画面の静的ファイル以外で必須（TTS_ADMIN_TOKEN でも通る）、
 *   /v1/admin/* は TTS_ADMIN_TOKEN があればその値（無ければ TTS_TOKEN の規則）。発行トークン（api-tokens.json）は通常の API だけ
 * - 本文は application/json だけ（ほかは 415）。CORS ヘッダは返さない
 * - 全応答に X-Request-Id を付け、応答が終わったらアクセスログを 1 行出す（ヘッダ・本文・クエリは出さない）
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { FfmpegProbe } from './audio/encode.ts';
import { AudioCache } from './cache.ts';
import { VERSION, type Config } from './config.ts';
import { createEngines, MODEL_EXTS, type EngineDeps } from './engines/index.ts';
import type { Engine } from './engines/types.ts';
import { ApiError, conflict, invalid, notFound } from './errors.ts';
import { log } from './log.ts';
import { loadCatalog, type CatalogModel } from './models/catalog.ts';
import { ModelDownloader } from './models/download.ts';
import { MAX_MODELS, MODEL_ID_RE, Registry, type ModelRecord } from './models/registry.ts';
import { isAllowed, isUnspecified, parseIp } from './net.ts';
import { SynthQueue } from './queue.ts';
import { SettingsStore, validateSettingsPatch } from './settings.ts';
import { Synthesizer } from './synthesize.ts';
import { Dictionary } from './text/readings.ts';
import { EXPIRES_IN_SEC, FLUSH_INTERVAL_MS, MAX_LABEL_CHARS, TokenStore, type TokenView } from './tokens.ts';
import { charCount, checkKeys, checkObject, checkReading, checkString, checkSurface } from './validate.ts';

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
  /** 発行した API トークン */
  tokens: TokenStore;
  /** ffmpeg の有無（30 秒たてば確かめ直す） */
  ffmpeg: FfmpegProbe;
  startedAt: number;
  /** 終了処理中（/health/ready が 503 を返す）。close() の先頭で true にする */
  shuttingDown: boolean;
  close: () => Promise<void>;
};

export type AppOverrides = {
  /** テスト用: 偽のエンジン */
  engines?: (deps: EngineDeps) => Map<string, Engine>;
  /** テスト用: モデル取得のホスト判定・許可するスキーム・ポート判定 */
  isHostAllowed?: (host: string) => boolean;
  protocols?: readonly string[];
  isPortAllowed?: (port: number) => boolean;
  /** テスト用: 発行トークンの時刻 */
  now?: () => number;
};

export const createApp = async (config: Config, o: AppOverrides = {}): Promise<App> => {
  const settings = await SettingsStore.load(config.dataDir);
  const registry = await Registry.load(config.dataDir, engine => MODEL_EXTS[engine]);
  const tokens = await TokenStore.load(config.dataDir, o.now);
  const engines = (o.engines ?? createEngines)({ registry, settings: () => settings.get(), concurrency: config.concurrency });
  const cache = new AudioCache({
    dir: config.cacheDir,
    maxBytes: () => settings.get().cacheMaxMB * 1024 * 1024,
    ttlMs: () => settings.get().cacheTtlDays * 86_400_000,
  });
  await cache.init();
  const queue = new SynthQueue({ concurrency: config.concurrency, max: config.queueMax, affinityMaxWaitMs: config.affinityMaxWaitMs });
  const dictionary = await Dictionary.load(join(config.packageDir, 'dict', 'readings.tsv'), join(config.dataDir, 'readings.tsv'));
  const catalog = loadCatalog(join(config.packageDir, 'catalog'));
  const downloader = new ModelDownloader({
    registry,
    engines,
    modelHosts: config.modelHosts,
    maxBytes: config.modelMaxBytes,
    timeoutMs: config.modelTimeoutSec * 1000,
    isHostAllowed: o.isHostAllowed,
    protocols: o.protocols,
    isPortAllowed: o.isPortAllowed,
  });
  // ffmpeg が無くても起動は続ける（wav はそのまま返せる）
  const ffmpeg = new FfmpegProbe(config.ffmpeg);
  await ffmpeg.get();
  const synth = new Synthesizer({
    engines, registry, settings, cache, queue, dictionary,
    maxChars: config.maxChars, timeoutSec: config.timeoutSec, ffmpeg: config.ffmpeg, ffmpegProbe: ffmpeg,
  });
  settings.onChange(() => {
    void cache.evict().catch(e => log.error(`cache evict failed: ${(e as Error).message}`));
    for (const e of engines.values()) (e as Engine & { settingsChanged?: () => void }).settingsChanged?.();
  });
  // 作ってから TTL を過ぎたものを 1 時間ごとに消す
  const sweep = setInterval(() => void cache.evict().catch(() => {}), 3_600_000);
  sweep.unref();
  // 発行トークンの掃除と最終使用時刻の書き込み
  const tokenTimer = setInterval(() => void tokens.tick(), FLUSH_INTERVAL_MS);
  tokenTimer.unref();
  const app: App = {
    config, engines, registry, settings, cache, queue, dictionary, catalog, downloader, synth, tokens, ffmpeg, startedAt: Date.now(),
    shuttingDown: false,
    close: async () => {
      app.shuttingDown = true;
      clearInterval(sweep);
      clearInterval(tokenTimer);
      await downloader.cancelAll();
      await Promise.all([...engines.values()].map(e => e.close()));
      await tokens.flush().catch(e => log.warn('cannot write api-tokens.json', { err: e }));
    },
  };
  return app;
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
  if (e.allow !== undefined) headers.Allow = e.allow;
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

/** Authorization: Bearer の値。無ければ null */
const bearerOf = (req: IncomingMessage): string | null => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return m ? m[1]!.trim() : null;
};

const tokenMatches = (presented: string | null, token: string): boolean =>
  presented !== null && timingSafeEqual(digest(presented), digest(token));

/**
 * 管理ルートは TTS_ADMIN_TOKEN（無ければ TTS_TOKEN）。ほかは TTS_TOKEN があれば必須で、TTS_ADMIN_TOKEN・有効な発行トークンでも通る。
 * 発行トークンで通ったときはその id を返す（アクセスログに付ける）
 */
const requireAuth = (req: IncomingMessage, app: App, admin: boolean): string | undefined => {
  const { config } = app;
  const presented = bearerOf(req);
  let ok: boolean;
  if (admin) {
    const token = config.adminToken || config.token;
    if (!token) return undefined;
    ok = tokenMatches(presented, token);
  } else {
    if (!config.token) return undefined;
    const user = tokenMatches(presented, config.token);
    const adminOk = !!config.adminToken && tokenMatches(presented, config.adminToken);
    ok = user || adminOk;
    if (!ok && presented !== null) {
      // 環境変数のトークンの後に発行トークンを見る
      const id = app.tokens.verify(presented);
      if (id !== null) return id;
    }
  }
  if (!ok) throw new ApiError(401, 'unauthorized', 'missing or invalid bearer token');
  return undefined;
};

// ---- Host / Origin ----

/**
 * Host ヘッダ（Origin の host 部分）の判定。TTS_HOSTS の各アドレス:ポート、ループバックなら localhost:ポート、TTS_ALLOWED_HOSTS（ポートは問わない）。
 * 未指定アドレス（0.0.0.0・::）はそれ自体を許さず、代わりにループバックの名前（127.0.0.1 か [::1]、と localhost）を許す
 */
const hostMatcher = (config: Config): ((host: string | undefined) => boolean) => {
  const exact = new Set<string>();
  const add = (name: string): void => {
    exact.add(`${name}:${config.port}`);
    if (config.port === 80) exact.add(name);
  };
  for (const h of config.hosts) {
    if (isUnspecified(h)) {
      add(parseIp(h)!.family === 4 ? '127.0.0.1' : '[::1]');
      add('localhost');
      continue;
    }
    const lower = h.toLowerCase();
    if (lower.includes(':')) {
      add(`[${lower}]`);
      // URL が正規化した形（[0:0::1] → [::1]）も許す
      try {
        add(new URL(`http://[${lower}]/`).hostname);
      } catch {}
    } else add(lower);
    const ip = parseIp(h);
    const local = !!ip && (ip.family === 4 ? ip.bytes.join('.') === '127.0.0.1' : ip.bytes.subarray(0, 15).every(x => x === 0) && ip.bytes[15] === 1);
    if (local) add('localhost');
  }
  const names = new Set(config.allowedHosts);
  return host => {
    if (!host) return false;
    const h = host.toLowerCase();
    if (exact.has(h)) return true;
    const m = /^([^:[\]]+)(?::\d+)?$/.exec(h);
    return !!m && names.has(m[1]!);
  };
};

/** Origin を見ないメソッド（ブラウザが他サイトから本文付きで送れない） */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const checkOrigin = (origin: string, hostOk: (host: string) => boolean): void => {
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {}
  if (!host || !hostOk(host)) throw new ApiError(403, 'forbidden_origin', 'request origin is not allowed');
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
  if (app.registry.list().length >= MAX_MODELS) throw invalid(`too many models (up to ${MAX_MODELS})`);
  if (app.downloader.isDeleting(engineId, rec.id)) throw conflict(`model ${rec.id} of ${engineId} is being deleted`, 'id');
  if (app.registry.get(engineId, rec.id)) throw conflict(`model ${rec.id} of ${engineId} already exists`, 'id');
  app.downloader.checkCapacity();
  await app.registry.add(rec);
  try {
    await app.downloader.start(rec);
  } catch (e) {
    // 始められなければ（同時取得の上限など）登録しない
    await app.registry.remove(engineId, rec.id);
    throw e;
  }
  return rec;
};

const deleteModel = async (app: App, engineId: string, id: string): Promise<void> => {
  const engine = app.engines.get(engineId);
  const rec = app.registry.get(engineId, id);
  if (!engine || !rec) throw notFound(`model ${id} of ${engineId} not found`);
  if (app.settings.get().defaultVoices[engineId] === id) throw conflict(`model ${id} is the default voice of ${engineId}`);
  // 取得中なら止めて .part が消えるのを待ってから消す。その間の同じ id の追加・取り直しは 409
  await app.downloader.remove(engineId, id, async () => {
    const path = app.registry.modelPath(engineId, id, engine.modelExt);
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
    await app.registry.remove(engineId, id);
  });
};

const issueToken = async (app: App, raw: unknown, f: ReqFields): Promise<{ view: TokenView; token: string }> => {
  const body = checkObject(raw, '');
  checkKeys(body, ['label', 'expiresInSec']);
  if (body.label === undefined) throw invalid('label is required', 'label');
  const label = checkString(body.label, 'label').trim();
  if (!label || charCount(label) > MAX_LABEL_CHARS) throw invalid(`label must be 1 to ${MAX_LABEL_CHARS} characters`, 'label');
  if (/\p{Cc}/u.test(label)) throw invalid('label must not contain control characters', 'label');
  if (body.expiresInSec === undefined) throw invalid('expiresInSec is required', 'expiresInSec');
  // null は無期限
  const expiresInSec = body.expiresInSec as number | null;
  if (expiresInSec !== null && !(EXPIRES_IN_SEC as readonly unknown[]).includes(expiresInSec))
    throw invalid(`expiresInSec must be one of ${EXPIRES_IN_SEC.join(', ')} or null`, 'expiresInSec');
  const r = await app.tokens.issue(label, expiresInSec);
  log.info('api token issued', { ...f, tokenId: r.view.id, label, expiresAt: r.view.expiresAt });
  return r;
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
  const body = checkObject(raw, '');
  checkKeys(body, ['reading']);
  if (body.reading === undefined) throw invalid('reading is required', 'reading');
  const reading = checkReading(checkString(body.reading, 'reading'), 'reading');
  await app.dictionary.set(surface, reading);
};

// ---- ルーティング ----

/** ログに付ける要求の情報 */
type ReqFields = { requestId: string; method: string; path: string; tokenId?: string };

type Route = {
  method: string; re: RegExp; admin: boolean; auth: boolean;
  run: (app: App, req: IncomingMessage, res: ServerResponse, m: string[], f: ReqFields) => Promise<void>;
};

const healthz: Route['run'] = async (_app, req, res) => {
  await noBody(req);
  // HEAD では node:http が本文を送らない
  sendJson(res, 200, { status: 'ok', version: VERSION });
};

/** 終了処理中・データディレクトリに書けないときは 503（エンジン・ffmpeg・声の有無は見ない） */
const ready: Route['run'] = async (app, req, res) => {
  await noBody(req);
  let reason = '';
  if (app.shuttingDown) reason = 'shutting down';
  else {
    try {
      await access(app.config.dataDir, fsConstants.W_OK | fsConstants.R_OK);
    } catch {
      reason = 'data directory is not writable';
    }
  }
  if (reason) sendJson(res, 503, { status: 'unavailable', reason });
  else sendJson(res, 200, { status: 'ok', version: VERSION });
};

const HEALTH_RE = /^\/(?:healthz|health|health\/live)$/;
const READY_RE = /^\/health\/ready$/;
/** アクセスログを debug にするパス */
const HEALTH_PATHS = new Set(['/healthz', '/health', '/health/live', '/health/ready']);

const routes: Route[] = [
  { method: 'GET', re: HEALTH_RE, admin: false, auth: false, run: healthz },
  { method: 'HEAD', re: HEALTH_RE, admin: false, auth: false, run: healthz },
  { method: 'GET', re: READY_RE, admin: false, auth: false, run: ready },
  { method: 'HEAD', re: READY_RE, admin: false, auth: false, run: ready },
  {
    method: 'GET', re: /^\/v1\/engines$/, admin: false, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, enginesJson(app));
    },
  },
  {
    method: 'POST', re: /^\/v1\/synthesize$/, admin: false, auth: true,
    run: async (app, req, res, _m, f) => {
      // 応答を返し終える前に接続が閉じたら合成を止める（合流中なら全員が切断したときだけ止まる）
      const ac = new AbortController();
      const onClose = (): void => {
        if (!res.writableFinished) ac.abort(new Error('client disconnected'));
      };
      res.on('close', onClose);
      const r = await app.synth.synthesize(await readJson(req), ac.signal).catch((e: unknown) => {
        if (!ac.signal.aborted) throw e;
        return null;
      });
      if (!r || ac.signal.aborted) {
        // 切断した要求には応答を書かない（エラー扱いにしない）
        log.info('client disconnected before the response', { ...f });
        return;
      }
      res.off('close', onClose);
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
      if (app.downloader.isDeleting(engineId, id)) throw conflict(`model ${id} is being deleted`);
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
    method: 'GET', re: /^\/v1\/admin\/tokens$/, admin: true, auth: true,
    run: async (app, req, res) => {
      await noBody(req);
      sendJson(res, 200, { enabled: !!app.config.token, tokens: app.tokens.list() });
    },
  },
  {
    method: 'POST', re: /^\/v1\/admin\/tokens$/, admin: true, auth: true,
    run: async (app, req, res, _m, f) => {
      const raw = await readJson(req);
      // TTS_TOKEN が無い構成では通常の API に認証が無く、発行しても意味が無い
      if (!app.config.token) throw conflict('API tokens require TTS_TOKEN to be set');
      const { view, token } = await issueToken(app, raw, f);
      sendJson(res, 201, { ...view, token });
    },
  },
  {
    method: 'DELETE', re: /^\/v1\/admin\/tokens\/([^/]+)$/, admin: true, auth: true,
    run: async (app, req, res, m, f) => {
      await noBody(req);
      const id = decodeSegment(m[1]!);
      const rec = await app.tokens.revoke(id);
      if (!rec) throw notFound(`token ${id} not found`);
      log.info('api token revoked', { ...f, tokenId: rec.id, label: rec.label });
      sendEmpty(res, 204);
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

const methodNotAllowed = (method: string, path: string, allow: string): ApiError => {
  const e = new ApiError(405, 'method_not_allowed', `${method} is not allowed for ${path}`);
  e.allow = allow;
  return e;
};

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** X-Request-Id（形が合えば）→ Cf-Ray → 生成 */
const requestIdOf = (req: IncomingMessage): string => {
  for (const name of ['x-request-id', 'cf-ray']) {
    const v = req.headers[name];
    if (typeof v === 'string' && REQUEST_ID_RE.test(v)) return v;
  }
  return randomUUID();
};

export const createHandler = (app: App): RequestListener => {
  const hostOk = hostMatcher(app.config);
  return async (req, res) => {
    const started = performance.now();
    const requestId = requestIdOf(req);
    const remote = req.socket.remoteAddress;
    // writeHead に渡したヘッダとまとめて送られる
    res.setHeader('X-Request-Id', requestId);
    // クエリを除いたパス（ログにも使う）。解釈できなければ 400
    let pathname: string | null = null;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {}
    const f: ReqFields = { requestId, method: req.method ?? 'GET', path: pathname ?? '-' };
    res.once('close', () => {
      const len = res.getHeader('content-length');
      const fields: Record<string, unknown> = {
        ...f,
        status: res.headersSent ? res.statusCode : 0,
        durationMs: Math.round(performance.now() - started),
        remote,
        bytes: len === undefined ? undefined : Number(len),
      };
      if (!res.headersSent) fields.aborted = true;
      (HEALTH_PATHS.has(f.path) ? log.debug : log.info)('request', fields);
    });
    try {
      if (!isAllowed(req.socket.remoteAddress, app.config.allowCidrs)) throw new ApiError(403, 'forbidden', 'client address is not allowed');
      if (!hostOk(req.headers.host)) throw new ApiError(421, 'misdirected_request', 'Host header is not one of the addresses this server answers for');
      const method = req.method ?? 'GET';
      if (req.headers.origin !== undefined && !SAFE_METHODS.has(method)) checkOrigin(req.headers.origin, hostOk);
      if (pathname === null) throw new ApiError(400, 'bad_request', 'invalid request target');
      const path = pathname;

      if (path === '/admin' || STATIC[path]) {
        if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(method, path, 'GET, HEAD');
        if (path === '/admin') {
          res.writeHead(301, { ...SECURITY_HEADERS, Location: '/admin/' });
          res.end();
        } else await serveStatic(res, app.config, path, method === 'HEAD');
        return;
      }
      const matched = routes.filter(r => r.re.test(path));
      const r = matched.find(x => x.method === method);
      if (r) {
        if (r.auth) {
          const tokenId = requireAuth(req, app, r.admin);
          if (tokenId) f.tokenId = tokenId;
        }
        await r.run(app, req, res, r.re.exec(path)!, f);
        return;
      }
      if (matched.length > 0) {
        // 同じパスのルートは認証の要否が同じ
        if (matched[0]!.auth) {
          const tokenId = requireAuth(req, app, matched[0]!.admin);
          if (tokenId) f.tokenId = tokenId;
        }
        throw methodNotAllowed(method, path, matched.map(x => x.method).join(', '));
      }
      // 未定義のパスも、トークンが要る構成なら先に 401（どのパスがあるかを未認証で探らせない）
      const tokenId = requireAuth(req, app, path.startsWith('/v1/admin/'));
      if (tokenId) f.tokenId = tokenId;
      throw notFound(`${method} ${path} not found`);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof ApiError) {
        if (e.status >= 500) log.error(e.message, { ...f, status: e.status, code: e.code });
        sendError(res, e);
      } else {
        log.error('internal error', { ...f, err: e });
        sendError(res, new ApiError(500, 'internal_error', 'internal error'));
      }
    }
  };
};
