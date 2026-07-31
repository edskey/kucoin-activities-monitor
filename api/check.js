const crypto = require('crypto');

const STATE_KEY = 'kucoin-activities-monitor:state:v1';
const LOCK_KEY = 'kucoin-activities-monitor:lock:v1';
const MAX_SENT_IDS = 1000;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function respond(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function matchesSecret(req) {
  const expected = process.env.KUCOIN_CHECK_SECRET || '';
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function redis(command) {
  const response = await fetch(env('KUCOIN_UPSTASH_REDIS_REST_URL').replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('KUCOIN_UPSTASH_REDIS_REST_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`Upstash: ${result.error || response.status}`);
  return result.result;
}

async function loadState() {
  const raw = await redis(['GET', STATE_KEY]);
  if (!raw) return { sources: {} };
  try { return JSON.parse(raw); } catch { return { sources: {} }; }
}

async function saveState(state) {
  const ttl = Number(process.env.KUCOIN_STATE_TTL_SECONDS || 2592000);
  await redis(['SET', STATE_KEY, JSON.stringify(state), 'EX', ttl]);
}

function uniqueIds(ids) {
  return [...new Set(ids)].slice(0, MAX_SENT_IDS);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isSafeUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function formatEvent(event) {
  const rows = (event.fields || []).map(([label, value]) =>
    `🔵 <b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`
  );
  return [
    '🔥 <b>Новая промоакция KuCoin</b>',
    '',
    `🔵 <b>Название:</b> ${escapeHtml(event.title)}`,
    ...rows,
    '',
    `🔵 <b>Ссылка:</b> <a href="${escapeHtml(event.url)}">Открыть</a>`,
  ].join('\n');
}

async function sendTelegram(text) {
  const response = await fetch(`https://api.telegram.org/bot${env('KUCOIN_TELEGRAM_BOT_TOKEN').trim()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env('KUCOIN_TELEGRAM_CHAT_ID').trim(),
      text,
      parse_mode: 'HTML',
      disable_notification: false,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`Telegram: ${body.description || response.status}`);
}

function payload(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || !Array.isArray(body.sources) || !Array.isArray(body.events)) return null;
  const sources = [...new Set(body.sources.map(String))].filter((name) => /^[a-z0-9_-]{1,100}$/i.test(name));
  if (sources.length !== body.sources.length) return null;
  const events = body.events.slice(0, 500).map((event) => ({
    source: String(event.source || '').slice(0, 100),
    id: String(event.id || '').slice(0, 1000),
    title: String(event.title || '').slice(0, 300),
    url: String(event.url || '').slice(0, 2000),
    fields: Array.isArray(event.fields)
      ? event.fields.slice(0, 30).map(([a, b]) => [String(a).slice(0, 100), String(b).slice(0, 500)])
      : [],
  })).filter((event) => sources.includes(event.source) && event.id && event.title && isSafeUrl(event.url));
  return events.length === body.events.slice(0, 500).length ? { sources, events } : null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return respond(res, 405, { error: 'method_not_allowed' });
  if (!matchesSecret(req)) return respond(res, 401, { error: 'unauthorized' });
  const input = payload(req);
  if (!input) return respond(res, 400, { error: 'invalid_payload' });

  let locked = false;
  try {
    locked = (await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', 60])) === 'OK';
    if (!locked) return respond(res, 202, { ok: true, skipped: 'already_running' });
    const state = await loadState();
    state.sources ||= {};
    const deliveries = [];

    for (const source of input.sources) {
      const events = input.events.filter((event) => event.source === source);
      const ids = events.map((event) => event.id);
      const existing = state.sources[source];
      if (!existing?.sentIds) {
        state.sources[source] = { sentIds: uniqueIds(ids) };
        continue;
      }
      const seen = new Set(existing.sentIds);
      deliveries.push(...events.filter((event) => !seen.has(event.id)).reverse());
    }

    state.checkedAt = new Date().toISOString();
    await saveState(state);
    for (const event of deliveries) {
      await sendTelegram(formatEvent(event));
      state.sources[event.source].sentIds = uniqueIds([event.id, ...state.sources[event.source].sentIds]);
      state.checkedAt = new Date().toISOString();
      await saveState(state);
    }
    return respond(res, 200, { ok: true, sent: deliveries.length, sources: input.sources.length });
  } catch (error) {
    return respond(res, 500, { ok: false, error: error.message });
  } finally {
    if (locked) {
      try { await redis(['DEL', LOCK_KEY]); } catch { /* lock expires */ }
    }
  }
}

module.exports = handler;
