const assert = require('node:assert/strict');
const test = require('node:test');
const adapter = require('../sources/kucoin-activities');

const { extractPeriod, extractPool, formatTimer, localizedUrl, parseNextData } = adapter._test;

function nextHtml(detail) {
  const payload = { props: { pageProps: { announcementData: { articleDetail: detail } } } };
  return `${' '.repeat(10_100)}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
}

test('extracts the last campaign end and keeps countdown out of the stable ID', () => {
  const text = [
    'Период кампании: с 10:00 30 июля 2026 года по 10:00 6 августа 2026 года (UTC)',
    'Период кампании: с 08:00 31 июля 2026 года по 08:00 14 августа 2026 года (UTC)',
  ].join('\n');
  const period = extractPeriod(text);
  assert.equal(period.startAt, Date.UTC(2026, 6, 30, 10, 0));
  assert.equal(period.endAt, Date.UTC(2026, 7, 14, 8, 0));
  assert.equal(formatTimer(period.endAt, Date.UTC(2026, 7, 13, 7, 30)), '1д 0ч 30м');
});

test('extracts stablecoin and token prize pools from Russian titles', () => {
  assert.deepEqual(extractPool('Кампания — 44 000 USDT в розыгрыше'), { amount: 44000, currency: 'USDT' });
  assert.deepEqual(extractPool('Розыгрыш призового пула в 310 000 AEON'), { amount: 310000, currency: 'AEON' });
});

test('builds a direct Russian URL and parses server-rendered detail JSON', () => {
  const item = {
    annId: 123,
    annUrl: 'https://www.kucoin.com/announcement/ru-example?lang=ru_RU',
  };
  assert.equal(localizedUrl(item), 'https://www.kucoin.com/ru/announcement/ru-example');
  const detail = parseNextData(nextHtml({ title: 'Акция', content: '<p>Текст</p>' }));
  assert.equal(detail.title, 'Акция');
});

test('collects only currently running cards and converts a token pool through CoinGecko', async (context) => {
  process.env.KUCOIN_COINGECKO_DEMO_API_KEY = 'demo-key';
  const items = [
    { annId: 1, annTitle: 'Розыгрыш 310 000 AEON', annDesc: 'Призовой пул', cTime: Date.UTC(2026, 6, 30), annUrl: 'https://www.kucoin.com/announcement/ru-active' },
    { annId: 2, annTitle: 'Розыгрыш 10 000 USDT', annDesc: 'Призовой пул', cTime: Date.UTC(2026, 6, 30), annUrl: 'https://www.kucoin.com/announcement/ru-future' },
    { annId: 3, annTitle: 'Розыгрыш 20 000 USDT', annDesc: 'Призовой пул', cTime: Date.UTC(2026, 6, 20), annUrl: 'https://www.kucoin.com/announcement/ru-expired' },
  ];
  const details = {
    'ru-active': '<p>Период кампании: с 10:00 30 июля 2026 года по 10:00 6 августа 2026 года (UTC)</p>',
    'ru-future': '<p>Период кампании: с 10:00 2 августа 2026 года по 10:00 8 августа 2026 года (UTC)</p>',
    'ru-expired': '<p>Период кампании: с 10:00 20 июля 2026 года по 10:00 31 июля 2026 года (UTC)</p>',
  };
  context.mock.method(global, 'fetch', async (url) => {
    const value = String(url);
    if (value.startsWith('https://api.kucoin.com/')) {
      return new Response(JSON.stringify({ code: '200000', data: { items } }));
    }
    if (value.includes('api.coingecko.com/api/v3/search')) {
      return new Response(JSON.stringify({ coins: [{ id: 'aeon', symbol: 'aeon', market_cap_rank: 100 }] }));
    }
    if (value.includes('api.coingecko.com/api/v3/simple/price')) {
      return new Response(JSON.stringify({ aeon: { usd: 2 } }));
    }
    const slug = value.split('/').pop();
    if (details[slug]) return new Response(nextHtml({ title: slug, content: details[slug], first_publish_at: 0 }));
    throw new Error(`Unexpected URL: ${value}`);
  });

  const events = await adapter.collect({ now: Date.UTC(2026, 7, 1, 10, 0) });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, '1');
  assert.equal(events[0].url, 'https://www.kucoin.com/ru/announcement/ru-active');
  assert.deepEqual(events[0].fields, [
    ['Объем пула', '310 000 AEON (≈ 620 000 USDT)'],
    ['Заканчивается через', '5д 0ч 0м'],
  ]);
});
