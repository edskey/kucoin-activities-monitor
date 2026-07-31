const ANNOUNCEMENTS_URL = 'https://api.kucoin.com/api/v3/announcements';
const SITE_ORIGIN = 'https://www.kucoin.com';
const SOURCE_NAME = 'kucoin-activities-ongoing';
const UNKNOWN_PERIOD_DAYS = 30;
const REQUEST_TIMEOUT_MS = 20_000;

const RU_MONTHS = new Map([
  ['января', 0], ['февраля', 1], ['марта', 2], ['апреля', 3],
  ['мая', 4], ['июня', 5], ['июля', 6], ['августа', 7],
  ['сентября', 8], ['октября', 9], ['ноября', 10], ['декабря', 11],
]);

const EN_MONTHS = new Map([
  ['january', 0], ['february', 1], ['march', 2], ['april', 3],
  ['may', 4], ['june', 5], ['july', 6], ['august', 7],
  ['september', 8], ['october', 9], ['november', 10], ['december', 11],
]);

const STABLES = new Set(['USDT', 'USDC']);

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function localizedUrl(item) {
  const raw = String(item.annUrl || '');
  let slug = '';
  try {
    const url = new URL(raw);
    slug = url.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    slug = raw.split('?')[0].split('/').filter(Boolean).pop() || '';
  }
  if (!slug) throw new Error(`KuCoin announcement ${item.annId} has no URL`);
  return `${SITE_ORIGIN}/ru/announcement/${encodeURIComponent(decodeURIComponent(slug))}`;
}

function parseNextData(html) {
  const match = String(html).match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('KuCoin detail page has no __NEXT_DATA__');
  const next = JSON.parse(match[1]);
  const detail = next?.props?.pageProps?.announcementData?.articleDetail;
  if (!detail?.content) throw new Error('KuCoin detail page has no article content');
  return detail;
}

function russianDateTokens(text) {
  const values = [];
  const pattern = /(\d{1,2}):(\d{2})(?::\d{2})?\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/giu;
  for (const match of String(text).matchAll(pattern)) {
    values.push(Date.UTC(Number(match[5]), RU_MONTHS.get(match[4].toLowerCase()), Number(match[3]), Number(match[1]), Number(match[2])));
  }
  return values;
}

function englishDateTokens(text) {
  const values = [];
  const monthNames = [...EN_MONTHS.keys()].join('|');
  const monthFirst = new RegExp(`(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(?:on\\s+)?(${monthNames})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'giu');
  const dayFirst = new RegExp(`(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(?:on\\s+)?(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})`, 'giu');
  for (const match of String(text).matchAll(monthFirst)) {
    values.push(Date.UTC(Number(match[5]), EN_MONTHS.get(match[3].toLowerCase()), Number(match[4]), Number(match[1]), Number(match[2])));
  }
  for (const match of String(text).matchAll(dayFirst)) {
    values.push(Date.UTC(Number(match[5]), EN_MONTHS.get(match[4].toLowerCase()), Number(match[3]), Number(match[1]), Number(match[2])));
  }
  return values;
}

function extractPeriod(text) {
  const lines = String(text).split('\n').filter((line) =>
    /период (?:кампании|акции|активности)|campaign period|activity period|promotion period/i.test(line)
  );
  const values = lines.flatMap((line) => [...russianDateTokens(line), ...englishDateTokens(line)]);
  if (!values.length) return { startAt: null, endAt: null };
  return { startAt: Math.min(...values), endAt: Math.max(...values) };
}

function parseAmount(raw) {
  const compact = String(raw).replace(/[\s\u00a0]/g, '');
  if (/^\d{1,3}(?:,\d{3})+$/.test(compact)) return Number(compact.replace(/,/g, ''));
  if (/^\d{1,3}(?:\.\d{3})+$/.test(compact)) return Number(compact.replace(/\./g, ''));
  return Number(compact.replace(',', '.'));
}

function extractPool(...parts) {
  const text = parts.filter(Boolean).join(' — ');
  const matches = [];
  const pattern = /((?:\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+(?:[.,]\d+)?))\s*([A-Z][A-Z0-9]{0,9})\b/g;
  for (const match of text.matchAll(pattern)) {
    const amount = parseAmount(match[1]);
    const currency = match[2].toUpperCase();
    const context = text.slice(Math.max(0, match.index - 70), match.index + match[0].length + 70);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!/(?:пул|розыгрыш|разыгр|раздач|награ|бонус|giveaway|prize|reward|share|bonus)/i.test(context)) continue;
    matches.push({ amount, currency });
  }
  return matches.sort((a, b) => b.amount - a.amount)[0] || null;
}

function formatNumber(value, maximumFractionDigits = 8) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits }).format(value);
}

function formatTimer(endAt, now) {
  if (!endAt) return 'не указан';
  let minutes = Math.max(0, Math.ceil((endAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  return `${days}д ${hours}ч ${minutes}м`;
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(`KuCoin request failed for ${url}: ${lastError?.message || lastError}`);
}

async function fetchAnnouncements() {
  const url = new URL(ANNOUNCEMENTS_URL);
  url.searchParams.set('currentPage', '1');
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('annType', 'activities');
  url.searchParams.set('lang', 'ru_RU');
  const response = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  const payload = await response.json();
  const items = payload?.code === '200000' ? payload?.data?.items : null;
  if (!Array.isArray(items) || items.length === 0) throw new Error('KuCoin activities API returned no items');
  return items;
}

async function fetchDetail(url) {
  const response = await fetchWithRetry(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; KuCoinActivitiesMonitor/1.0)' },
  });
  const html = await response.text();
  if (html.length < 10_000) throw new Error(`KuCoin detail page is unexpectedly short: ${url}`);
  return parseNextData(html);
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const coinIdCache = new Map();

async function coinGeckoUsdtValue(pool) {
  if (!pool || STABLES.has(pool.currency)) return pool?.amount ?? null;
  const apiKey = process.env.KUCOIN_COINGECKO_DEMO_API_KEY;
  if (!apiKey) return null;
  let coinId = coinIdCache.get(pool.currency);
  if (!coinId) {
    const searchUrl = new URL('https://api.coingecko.com/api/v3/search');
    searchUrl.searchParams.set('query', pool.currency);
    const search = await fetchWithRetry(searchUrl, { headers: { 'x-cg-demo-api-key': apiKey, Accept: 'application/json' } });
    const coins = (await search.json())?.coins || [];
    const exact = coins.filter((coin) => String(coin.symbol).toUpperCase() === pool.currency)
      .sort((a, b) => (a.market_cap_rank || Number.MAX_SAFE_INTEGER) - (b.market_cap_rank || Number.MAX_SAFE_INTEGER));
    coinId = exact[0]?.id;
    if (!coinId) return null;
    coinIdCache.set(pool.currency, coinId);
  }
  const priceUrl = new URL('https://api.coingecko.com/api/v3/simple/price');
  priceUrl.searchParams.set('ids', coinId);
  priceUrl.searchParams.set('vs_currencies', 'usd');
  const response = await fetchWithRetry(priceUrl, { headers: { 'x-cg-demo-api-key': apiKey, Accept: 'application/json' } });
  const usd = Number((await response.json())?.[coinId]?.usd);
  return Number.isFinite(usd) && usd > 0 ? pool.amount * usd : null;
}

async function normalizeAnnouncement(item, now) {
  const url = localizedUrl(item);
  const detail = await fetchDetail(url);
  const text = htmlToText(detail.content);
  const period = extractPeriod(text);
  const publishedAt = Number(item.cTime || detail.first_publish_at * 1000 || 0);
  const hasStarted = !period.startAt || period.startAt <= now;
  const hasNotEnded = period.endAt
    ? period.endAt > now
    : publishedAt > 0 && publishedAt + UNKNOWN_PERIOD_DAYS * 86_400_000 > now;
  if (!hasStarted || !hasNotEnded) return null;

  const title = String(item.annTitle || detail.title || '').trim();
  const pool = extractPool(title, item.annDesc, detail.summary, text.slice(0, 2500));
  const usdtValue = await coinGeckoUsdtValue(pool);
  let poolText = 'не указан';
  if (pool) {
    poolText = `${formatNumber(pool.amount)} ${pool.currency}`;
    if (!STABLES.has(pool.currency)) {
      poolText += usdtValue === null
        ? ' (оценка в USDT недоступна)'
        : ` (≈ ${formatNumber(usdtValue, 2)} USDT)`;
    }
  }
  return {
    source: SOURCE_NAME,
    id: String(item.annId),
    title,
    url,
    fields: [
      ['Объем пула', poolText],
      ['Заканчивается через', formatTimer(period.endAt, now)],
    ],
  };
}

async function collect(options = {}) {
  const now = Number(options.now ?? Date.now());
  const items = await fetchAnnouncements();
  const events = await mapConcurrent(items, 4, (item) => normalizeAnnouncement(item, now));
  return events.filter(Boolean);
}

module.exports = {
  name: SOURCE_NAME,
  collect,
  _test: {
    extractPeriod,
    extractPool,
    formatTimer,
    htmlToText,
    localizedUrl,
    normalizeAnnouncement,
    parseNextData,
  },
};
