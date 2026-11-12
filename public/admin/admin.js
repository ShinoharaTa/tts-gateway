// tts-gateway の設定画面。素の JS（外部ライブラリなし）。サーバーの API（/v1/*）だけを呼ぶ。
'use strict';

const TOKEN_KEY = 'tts-gateway-token';
const ENGINE = 'zen-tts';
const EXT = { wav: 'wav', mp3: 'mp3', opus: 'ogg', m4a: 'm4a', flac: 'flac' };

const $ = id => document.getElementById(id);

/** 要素を作る。children の文字列は textContent（HTML として解釈しない） */
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
};

const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};

const setMsg = (id, text, kind = '') => {
  const el = $(id);
  el.textContent = text;
  el.className = `msg${kind ? ` ${kind}` : ''}`;
};

class ApiFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** API を呼ぶ。トークンがあれば Authorization に付ける。401 ならトークンの欄を出す */
const api = async (path, { method = 'GET', body, raw = false } = {}) => {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    let code = 'error';
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
    } catch {}
    if (res.status === 401) $('token-card').hidden = false;
    throw new ApiFailure(res.status, code, message);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
};

const errText = e => (e instanceof ApiFailure ? `${e.message}（${e.status} ${e.code}）` : String(e?.message ?? e));

const mb = n => (n === null || n === undefined ? '—' : `${(n / 1024 / 1024).toFixed(1)} MB`);
const duration = sec => {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 時間 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 日 ${Math.floor((sec % 86400) / 3600)} 時間`;
};

const PROCESS_STATE = { starting: '読み込み中', idle: '待機中', busy: '合成中' };

const STATUS_LABEL = { pending: '未取得', downloading: 'ダウンロード中', verifying: '検査中', installed: 'インストール済み', error: 'エラー' };

// ---- 状態 ----

let installedVoices = [];
let settings = null;

const loadStatus = async () => {
  try {
    const s = await api('/v1/admin/status');
    $('version').textContent = `v${s.version}`;
    const e = s.engines.find(x => x.id === ENGINE) ?? s.engines[0];
    // 合成プロセスはスロットごとに 1 行
    const procs = e?.processes ?? [];
    const items = [
      ['稼働時間', duration(s.uptimeSec)],
      ...(procs.length
        ? procs.map(p => [
            `合成プロセス ${p.slot + 1}`,
            `${p.voice}（${PROCESS_STATE[p.state] ?? p.state}）・${mb(p.rssBytes)}`,
          ])
        : [['合成プロセス', 'なし']]),
      ['カーネル', e?.kernel ?? '—'],
      ['サーバーのメモリ', mb(s.memory.rssBytes)],
      ['合成中 / 待ち', `${s.queue.running} / ${s.queue.waiting}（上限 ${s.queue.max}）`],
      ['キャッシュ', `${s.cache.entries} 件・${mb(s.cache.bytes)}`],
      ['ffmpeg', s.ffmpeg.available ? (s.ffmpeg.version ?? 'あり') : 'なし（wav だけ使えます）'],
    ];
    $('status').replaceChildren(...items.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
    setMsg('status-msg', '');
  } catch (e) {
    setMsg('status-msg', errText(e), 'error');
  }
};

// ---- 声の一覧（試聴・設定） ----

const loadVoices = async () => {
  const r = await api('/v1/engines');
  const eng = r.engines.find(x => x.id === ENGINE);
  installedVoices = (eng?.voices ?? []).filter(v => v.installed);
  const def = r.default.engine === ENGINE ? r.default.voice : null;
  const fill = (select, current) => {
    const prev = current ?? select.value;
    select.replaceChildren(
      ...(installedVoices.length
        ? installedVoices.map(v => h('option', { value: v.id, selected: v.id === prev }, `${v.name}（${v.id}）`))
        : [h('option', { value: '' }, 'インストール済みの声がありません')]),
    );
  };
  fill($('try-voice'), $('try-voice').value || def);
  fill($('set-voice'), def);
};

// ---- 試聴 ----

let audioUrl = null;

const trySubmit = async ev => {
  ev.preventDefault();
  const text = $('try-text').value;
  const voice = $('try-voice').value || undefined;
  const format = $('try-format').value;
  const emotion = $('try-emotion').value;
  const zenTts = { speed: Number($('try-speed').value), pitch: Number($('try-pitch').value) };
  if (emotion !== 'neutral') zenTts.emotion = { [emotion]: 100 };
  const body = { text, voice, format, zenTts };
  $('try-submit').disabled = true;
  setMsg('try-msg', '合成しています…');
  try {
    // 読みは合成の前に出す（合成に時間がかかっても先に見える）
    await showNormalize({ text, voice, format, zenTts });
    const res = await api('/v1/synthesize', { method: 'POST', body, raw: true });
    const blob = await res.blob();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    const audio = $('try-audio');
    audio.src = audioUrl;
    audio.hidden = false;
    const dl = $('try-download');
    dl.href = audioUrl;
    dl.download = `tts.${EXT[format]}`;
    dl.hidden = false;
    const cache = res.headers.get('X-Cache');
    setMsg(
      'try-msg',
      `${(Number(res.headers.get('X-Audio-Duration-Ms')) / 1000).toFixed(1)} 秒の音声・合成 ${res.headers.get('X-Synthesis-Ms')} ms・キャッシュ ${cache}・${mb(blob.size)}`,
      'ok',
    );
    void audio.play().catch(() => {});
    void loadStatus();
  } catch (e) {
    setMsg('try-msg', errText(e), 'error');
  } finally {
    $('try-submit').disabled = false;
  }
};

const showNormalize = async body => {
  const n = await api('/v1/normalize', { method: 'POST', body });
  $('try-normalize').hidden = false;
  $('try-spoken').textContent = n.spoken;
  $('try-unknown-empty').hidden = n.unknownWords.length > 0;
  $('try-unknown').replaceChildren(
    ...n.unknownWords.map(w =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          title: '辞書の追加欄に入れる',
          onclick: () => {
            $('dict-surface').value = w.word;
            $('dict-reading').value = '';
            $('dict-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
            $('dict-reading').focus({ preventScroll: true });
          },
        },
        w.count > 1 ? `${w.word} ×${w.count}` : w.word,
      ),
    ),
  );
};

// ---- モデル ----

let pollTimer = null;
let polling = false; // ダウンロード中・検査中のモデルがあり、状態を取りに行っている
let pollFailures = 0; // ポーリング中の連続失敗回数
const POLL_FAIL_LIMIT = 5;
const POLL_FAIL_TEXT = '状態を取得できません。通信を確認してください。';

const schedulePoll = ms => {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loadModels, ms);
};

const loadModels = async () => {
  try {
    const [{ models }, { models: catalog }] = await Promise.all([api('/v1/admin/models'), api('/v1/admin/catalog')]);
    const def = settings?.defaultVoices?.[ENGINE];
    $('models').replaceChildren(
      ...(models.length ? models.map(m => modelItem(m, def)) : [h('li', { class: 'muted' }, 'まだありません。カタログから追加してください。')]),
    );
    const rest = catalog.filter(c => !c.registered);
    $('catalog-select').replaceChildren(
      ...(rest.length
        ? rest.map(c => h('option', { value: `${c.engine}/${c.id}` }, `${c.name}（${c.id}・${mb(c.bytes)}）`))
        : [h('option', { value: '' }, '追加できるモデルはありません')]),
    );
    $('catalog-form').querySelector('button').disabled = rest.length === 0;
    if (pollFailures >= POLL_FAIL_LIMIT) setMsg('models-msg', '');
    pollFailures = 0;
    polling = models.some(m => m.status === 'downloading' || m.status === 'verifying');
    if (polling) schedulePoll(1000);
    else {
      clearTimeout(pollTimer);
      if (models.some(m => m.status === 'installed')) void loadVoices().catch(() => {});
    }
  } catch (e) {
    if (!polling) {
      setMsg('models-msg', errText(e), 'error');
      return;
    }
    // ポーリング中の失敗では止めない。続けて失敗したら知らせて間隔を空ける
    pollFailures += 1;
    if (pollFailures >= POLL_FAIL_LIMIT) setMsg('models-msg', POLL_FAIL_TEXT, 'error');
    schedulePoll(pollFailures >= POLL_FAIL_LIMIT ? 5000 : 1000);
  }
};

const modelItem = (m, def) => {
  const p = m.progress;
  const bar =
    m.status === 'downloading'
      ? [
          p?.totalBytes ? h('progress', { max: p.totalBytes, value: p.receivedBytes }) : h('progress'),
          h('span', { class: 'muted small' }, `${mb(p?.receivedBytes ?? 0)}${p?.totalBytes ? ` / ${mb(p.totalBytes)}` : ''}`),
        ]
      : m.status === 'verifying'
        ? [h('progress')]
        : [];
  const actions = [];
  if (m.status === 'pending' || m.status === 'error')
    actions.push(h('button', { type: 'button', class: 'ghost small-button', onclick: () => redownload(m) }, '取り直し'));
  if (m.id !== def || m.engine !== ENGINE)
    actions.push(h('button', { type: 'button', class: 'ghost danger small-button', onclick: () => removeModel(m) }, '削除'));
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'name' }, m.name),
      h('span', { class: 'muted small' }, `${m.engine} / ${m.id}`),
      h('span', { class: `badge ${m.status}` }, STATUS_LABEL[m.status] ?? m.status),
      m.id === def ? h('span', { class: 'badge user' }, '既定') : null,
      m.bytes ? h('span', { class: 'muted small' }, mb(m.bytes)) : null,
    ),
    ...bar,
    m.error ? h('span', { class: 'msg error' }, m.error) : null,
    h('span', { class: 'muted small' }, m.source.url),
    actions.length ? h('div', { class: 'actions' }, ...actions) : null,
  );
};

const redownload = async m => {
  try {
    await api(`/v1/admin/models/${encodeURIComponent(m.engine)}/${encodeURIComponent(m.id)}/download`, { method: 'POST' });
    setMsg('models-msg', `${m.name} を取り直しています`);
  } catch (e) {
    setMsg('models-msg', errText(e), 'error');
  }
  await loadModels();
};

const removeModel = async m => {
  if (!confirm(`${m.name}（${m.id}）の登録と重みのファイルを消します。よろしいですか？`)) return;
  try {
    await api(`/v1/admin/models/${encodeURIComponent(m.engine)}/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
    setMsg('models-msg', `${m.name} を消しました`, 'ok');
  } catch (e) {
    setMsg('models-msg', errText(e), 'error');
  }
  await loadModels();
  await loadVoices().catch(() => {});
};

const addModel = async body => {
  try {
    const m = await api('/v1/admin/models', { method: 'POST', body });
    setMsg('models-msg', `${m.name} のダウンロードを始めました`);
    return true;
  } catch (e) {
    setMsg('models-msg', errText(e), 'error');
    return false;
  } finally {
    await loadModels();
  }
};

// ---- 読み辞書 ----

let dictEntries = [];

const DICT_LIMIT = 300;
let dictFilterTimer = null;

const renderDict = () => {
  const q = $('dict-filter').value.trim().toLowerCase();
  const list = dictEntries.filter(e => !q || e.surface.toLowerCase().includes(q) || e.reading.toLowerCase().includes(q));
  $('dict-count').textContent = `${list.length} / ${dictEntries.length} 語`;
  const more = $('dict-more');
  more.textContent = list.length > DICT_LIMIT ? `${list.length} 件中 ${DICT_LIMIT} 件を表示。絞り込むと残りを探せます。` : '';
  more.hidden = list.length <= DICT_LIMIT;
  // ユーザーの語を先に
  list.sort((a, b) => (a.source === b.source ? 0 : a.source === 'user' ? -1 : 1));
  $('dict').replaceChildren(
    ...list.slice(0, DICT_LIMIT).map(e =>
      h(
        'li',
        {},
        h(
          'div',
          { class: 'head' },
          h('span', { class: 'name' }, e.surface),
          h('span', {}, e.reading),
          h('span', { class: `badge ${e.source}` }, e.source === 'user' ? 'ユーザー' : '組み込み'),
        ),
        e.source === 'user'
          ? h('button', { type: 'button', class: 'ghost danger small-button', onclick: () => removeReading(e.surface) }, '削除')
          : h('button', {
              type: 'button',
              class: 'ghost small-button',
              onclick: () => {
                $('dict-surface').value = e.surface;
                $('dict-reading').value = e.reading;
                $('dict-reading').focus();
              },
            }, '編集'),
      ),
    ),
  );
};

const loadDict = async () => {
  try {
    const d = await api('/v1/dictionary');
    dictEntries = d.entries;
    renderDict();
  } catch (e) {
    setMsg('dict-msg', errText(e), 'error');
  }
};

const removeReading = async surface => {
  if (!confirm(`「${surface}」を辞書から削除しますか？`)) return;
  try {
    const d = await api(`/v1/admin/dictionary/${encodeURIComponent(surface)}`, { method: 'DELETE' });
    dictEntries = d.entries;
    renderDict();
    setMsg('dict-msg', `${surface} をユーザー辞書から消しました`, 'ok');
  } catch (e) {
    setMsg('dict-msg', errText(e), 'error');
  }
};

// ---- 設定 ----

const loadSettings = async () => {
  try {
    settings = await api('/v1/admin/settings');
    $('set-idle').value = settings.idleUnloadSec;
    $('set-cache-mb').value = settings.cacheMaxMB;
    $('set-ttl').value = settings.cacheTtlDays;
  } catch (e) {
    setMsg('settings-msg', errText(e), 'error');
  }
};

const saveSettings = async ev => {
  ev.preventDefault();
  const body = {
    idleUnloadSec: Number($('set-idle').value),
    cacheMaxMB: Number($('set-cache-mb').value),
    cacheTtlDays: Number($('set-ttl').value),
  };
  const voice = $('set-voice').value;
  if (voice) body.defaultVoices = { [ENGINE]: voice };
  try {
    settings = await api('/v1/admin/settings', { method: 'PUT', body });
    setMsg('settings-msg', '保存しました', 'ok');
    await Promise.all([loadVoices(), loadModels(), loadStatus()]);
  } catch (e) {
    setMsg('settings-msg', errText(e), 'error');
  }
};

// ---- 起動 ----

const loadAll = async () => {
  await loadSettings();
  await Promise.all([loadStatus(), loadVoices().catch(e => setMsg('try-msg', errText(e), 'error')), loadModels(), loadDict()]);
};

document.addEventListener('DOMContentLoaded', () => {
  $('token-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      localStorage.setItem(TOKEN_KEY, $('token-input').value.trim());
    } catch {
      setMsg('token-msg', 'このブラウザではトークンを保存できません', 'error');
      return;
    }
    $('token-input').value = '';
    $('token-card').hidden = true;
    await loadAll();
  });

  $('status-refresh').addEventListener('click', () => void loadStatus());
  $('try-form').addEventListener('submit', trySubmit);
  $('try-speed').addEventListener('input', () => ($('try-speed-out').textContent = Number($('try-speed').value).toFixed(2)));
  $('try-pitch').addEventListener('input', () => ($('try-pitch-out').textContent = $('try-pitch').value));

  $('catalog-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const v = $('catalog-select').value;
    if (!v) return;
    const [engine, catalog] = v.split('/');
    await addModel({ engine, catalog });
  });

  $('url-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const body = { engine: ENGINE, id: $('url-id').value.trim(), url: $('url-url').value.trim() };
    const name = $('url-name').value.trim();
    const sha = $('url-sha').value.trim();
    if (name) body.name = name;
    if (sha) body.sha256 = sha;
    if (await addModel(body)) $('url-form').reset();
  });

  $('dict-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const surface = $('dict-surface').value.trim();
    const reading = $('dict-reading').value.trim();
    try {
      const d = await api(`/v1/admin/dictionary/${encodeURIComponent(surface)}`, { method: 'PUT', body: { reading } });
      dictEntries = d.entries;
      $('dict-filter').value = surface;
      renderDict();
      $('dict-form').reset();
      setMsg('dict-msg', `${surface} → ${reading} を登録しました`, 'ok');
    } catch (e) {
      setMsg('dict-msg', errText(e), 'error');
    }
  });
  $('dict-filter').addEventListener('input', () => {
    clearTimeout(dictFilterTimer);
    dictFilterTimer = setTimeout(renderDict, 150);
  });

  $('settings-form').addEventListener('submit', saveSettings);
  $('cache-clear').addEventListener('click', async () => {
    if (!confirm('音声キャッシュを全部消します。よろしいですか？')) return;
    try {
      await api('/v1/admin/cache', { method: 'DELETE' });
      setMsg('settings-msg', 'キャッシュを消しました', 'ok');
      await loadStatus();
    } catch (e) {
      setMsg('settings-msg', errText(e), 'error');
    }
  });

  void loadAll();
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadStatus();
  }, 10_000);
});
