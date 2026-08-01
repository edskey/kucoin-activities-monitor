const crypto = require('crypto');

const LOCALES = new Set([
  'ar', 'bn', 'de', 'es', 'fil', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'ms',
  'nl', 'pl', 'pt', 'ru', 'th', 'tr', 'uk', 'ur', 'vi', 'zh-hant',
]);

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function canonicalPath(value) {
  try {
    const url = new URL(String(value));
    if (!/(^|\.)kucoin\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (LOCALES.has(String(parts[0] || '').toLowerCase())) parts.shift();
    const path = `/${parts.map((part) => decodeURIComponent(part)).join('/')}`;
    return path.replace(/\/+$/, '').toLowerCase() || '/';
  } catch {
    return null;
  }
}

function campaignCodes(...values) {
  const codes = new Set();
  const pattern = /\/campaigns\/([^?#"'&<>\s/]+)/giu;
  for (const value of values.flat(Infinity)) {
    const text = String(value || '');
    if (text && !text.includes('/') && text.length <= 200) codes.add(text.toLowerCase());
    for (const match of text.matchAll(pattern)) {
      try { codes.add(decodeURIComponent(match[1]).toLowerCase()); } catch { codes.add(match[1].toLowerCase()); }
    }
  }
  return [...codes].filter(Boolean);
}

function buildKucoinMatchKeys({ url, title, endAt, codes = [], content = '' }) {
  const keys = new Set();
  const path = canonicalPath(url);
  if (path) keys.add(`kucoin:url:${path}`);
  for (const code of campaignCodes(codes, url, content)) keys.add(`kucoin:campaign:${code}`);
  const normalizedTitle = normalizeTitle(title);
  const endDay = Number.isFinite(Number(endAt)) && Number(endAt) > 0
    ? new Date(Number(endAt)).toISOString().slice(0, 10)
    : '';
  if (normalizedTitle && endDay) keys.add(`kucoin:title-period:${digest(`${normalizedTitle}|${endDay}`)}`);
  return [...keys].slice(0, 20);
}

module.exports = {
  buildKucoinMatchKeys,
  campaignCodes,
  canonicalPath,
  normalizeTitle,
};
