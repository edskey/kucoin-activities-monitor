const activities = require('./kucoin-activities');
const { buildKucoinMatchKeys } = require('./kucoin-identity');

const EVENTS_URL = 'https://www.kucoin.com/_api/growth-campaign/api/campaign/list';
const SITE_ORIGIN = 'https://www.kucoin.com';
const SOURCE_NAME = 'kucoin-events-hub-ongoing';

const {
  extractExplicitPool,
  fetchWithRetry,
  formatPoolText,
  formatTimer,
  htmlToText,
} = activities.shared;

function localizedCampaignUrl(item) {
  let code = String(item.code || '').trim();
  if (!code) {
    try {
      const url = new URL(String(item.webUrl || ''));
      const match = url.pathname.match(/\/campaigns\/([^/]+)/i);
      code = match ? decodeURIComponent(match[1]) : '';
    } catch { /* validated below */ }
  }
  if (!code || !/^[a-z0-9_-]{1,200}$/i.test(code)) {
    throw new Error(`KuCoin Events Hub item ${item.id || 'unknown'} has no valid campaign code`);
  }
  return `${SITE_ORIGIN}/ru/campaigns/${encodeURIComponent(code)}`;
}

function parseInitialPageState(html) {
  const source = String(html || '');
  const marker = /window\.g_initialPageState\s*=\s*/g.exec(source);
  if (!marker) throw new Error('KuCoin campaign page has no g_initialPageState');
  const start = marker.index + marker[0].length;
  if (source[start] !== '{') throw new Error('KuCoin campaign state is not a JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) throw new Error('KuCoin campaign page has an incomplete g_initialPageState');
  const raw = source.slice(start, end);
  const state = JSON.parse(raw);
  const page = Object.values(state)[0];
  if (!page || typeof page !== 'object') throw new Error('KuCoin campaign state has no page data');
  return page;
}

function collectStrings(value, output, depth = 0) {
  if (output.length >= 10_000 || depth > 20 || value == null) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output, depth + 1);
  }
}

function campaignText(html) {
  const page = parseInitialPageState(html);
  const strings = [];
  collectStrings(page?.businessData?.components, strings);
  const campaignLocales = page?.legoV3?.pageData?.pageJson?.locales;
  const localized = page?.ssgCacheLang?.langMap?.currentLocale || page?.legoV3?.pageData?.locales;
  if (campaignLocales && typeof campaignLocales === 'object') {
    for (const [key, value] of Object.entries(campaignLocales)) {
      collectStrings(localized?.[key] ?? value, strings);
    }
  }
  if (!strings.length) throw new Error('KuCoin campaign page has no campaign content');
  return htmlToText(strings.join('\n'));
}

function itemMatchKeys(item) {
  return buildKucoinMatchKeys({
    url: localizedCampaignUrl(item),
    title: item.title,
    endAt: Number(item.endTime || 0),
    codes: [item.code],
  });
}

function dedupeItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const keys = [
      item.id ? `kucoin:hub-id:${String(item.id).toLowerCase()}` : '',
      ...itemMatchKeys(item),
    ].filter(Boolean);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    unique.push(item);
  }
  return unique;
}

async function fetchItems() {
  const url = new URL(EVENTS_URL);
  url.searchParams.set('hot', '0');
  url.searchParams.set('bizStatus', '1');
  url.searchParams.set('tab', '');
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent': 'Mozilla/5.0 (compatible; KuCoinEventsHubMonitor/1.0)',
      'X-Language': 'ru_RU',
    },
  });
  const payload = await response.json();
  if (payload?.success !== true || payload?.code !== '200' || !Array.isArray(payload.items)) {
    throw new Error('KuCoin Events Hub API returned an invalid payload');
  }
  return payload.items;
}

async function fetchCampaign(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: 'text/html',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'User-Agent': 'Mozilla/5.0 (compatible; KuCoinEventsHubMonitor/1.0)',
    },
  });
  const html = await response.text();
  if (html.length < 10_000) throw new Error(`KuCoin campaign page is unexpectedly short: ${url}`);
  return html;
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

async function normalizeItem(item, now) {
  const startAt = Number(item.startTime || 0) || null;
  const endAt = Number(item.endTime || 0) || null;
  if ((startAt && startAt > now) || (endAt && endAt <= now)) return null;
  const title = String(item.title || '').trim();
  if (!title) throw new Error(`KuCoin Events Hub item ${item.id || 'unknown'} has no title`);
  const url = localizedCampaignUrl(item);
  let detailText;
  try {
    detailText = campaignText(await fetchCampaign(url));
  } catch (error) {
    throw new Error(`KuCoin campaign parse failed for ${url}: ${error.message}`);
  }
  const pool = extractExplicitPool(title, item.subTitle, detailText.slice(0, 100_000));
  return {
    source: SOURCE_NAME,
    id: String(item.id || item.code),
    title,
    url,
    fields: [
      ['Объем пула', await formatPoolText(pool)],
      ['Заканчивается через', formatTimer(endAt, now)],
    ],
    matchKeys: itemMatchKeys(item),
  };
}

async function collect(options = {}) {
  const rawItems = await fetchItems();
  const items = dedupeItems(rawItems);
  const apiNow = Number(items.find((item) => Number(item.currentTime))?.currentTime);
  const now = Number(options.now ?? (Number.isFinite(apiNow) ? apiNow : Date.now()));
  const events = await mapConcurrent(items, 3, (item) => normalizeItem(item, now));
  return events.filter(Boolean);
}

module.exports = {
  name: SOURCE_NAME,
  collect,
  _test: {
    campaignText,
    dedupeItems,
    itemMatchKeys,
    localizedCampaignUrl,
    normalizeItem,
    parseInitialPageState,
  },
};
