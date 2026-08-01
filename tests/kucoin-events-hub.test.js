const assert = require('node:assert/strict');
const test = require('node:test');
const adapter = require('../sources/kucoin-events-hub');

const { campaignText, dedupeItems, localizedCampaignUrl, parseInitialPageState } = adapter._test;

function campaignHtml(content) {
  const state = {
    '/ru/campaigns/test': {
      businessData: { components: { hero: { title: 'Тестовая кампания' } } },
      legoV3: { pageData: { pageJson: { locales: { rules: content } } } },
    },
  };
  return `${' '.repeat(10_100)}<script>window.g_initialPageState = ${JSON.stringify(state)};</script>`;
}

function item(overrides = {}) {
  return {
    id: 'hub-1',
    code: 'Campaign_Test_2026',
    title: 'Тестовая кампания KuCoin',
    subTitle: 'Разделите призовой пул',
    startTime: Date.UTC(2026, 6, 30),
    endTime: Date.UTC(2026, 7, 6, 10),
    currentTime: Date.UTC(2026, 7, 1, 10),
    webUrl: 'https://www.kucoin.com/campaigns/Campaign_Test_2026?utm_source=hub',
    ...overrides,
  };
}

test('parses campaign state and builds a direct Russian URL', () => {
  const html = campaignHtml('<p>Общий призовой пул составляет 200,000 USDT</p>');
  assert(parseInitialPageState(html).businessData);
  assert.match(campaignText(html), /200,000 USDT/);
  assert.equal(localizedCampaignUrl(item()), 'https://www.kucoin.com/ru/campaigns/Campaign_Test_2026');
});

test('deduplicates Hub cards by campaign code and title with period', () => {
  const items = [
    item(),
    item({ id: 'hub-2', webUrl: 'https://www.kucoin.com/campaigns/Campaign_Test_2026?from=duplicate' }),
    item({ id: 'hub-3', code: 'different-code', webUrl: 'https://www.kucoin.com/campaigns/different-code' }),
    item({ id: 'hub-4', code: 'unique-code', title: 'Другая кампания', webUrl: 'https://www.kucoin.com/campaigns/unique-code' }),
  ];
  assert.deepEqual(dedupeItems(items).map((entry) => entry.id), ['hub-1', 'hub-4']);
});

test('collects only current Hub cards and reads the pool from the campaign page', async (context) => {
  delete process.env.KUCOIN_COINGECKO_DEMO_API_KEY;
  const active = item();
  const duplicate = item({ id: 'hub-copy' });
  const future = item({
    id: 'hub-future',
    code: 'future-code',
    title: 'Будущая кампания',
    startTime: Date.UTC(2026, 7, 2),
    endTime: Date.UTC(2026, 7, 8),
    webUrl: 'https://www.kucoin.com/campaigns/future-code',
  });
  let detailRequests = 0;
  context.mock.method(global, 'fetch', async (url) => {
    const value = String(url);
    if (value.includes('/_api/growth-campaign/api/campaign/list')) {
      assert.match(value, /bizStatus=1/);
      assert.match(value, /hot=0/);
      return new Response(JSON.stringify({ success: true, code: '200', items: [active, duplicate, future] }));
    }
    if (value.includes('/ru/campaigns/Campaign_Test_2026')) {
      detailRequests += 1;
      return new Response(campaignHtml('<p>Общий призовой пул составляет 200,000 USDT</p>'));
    }
    throw new Error(`Unexpected URL: ${value}`);
  });

  const events = await adapter.collect({ now: Date.UTC(2026, 7, 1, 10) });
  assert.equal(events.length, 1);
  assert.equal(detailRequests, 1);
  assert.equal(events[0].source, 'kucoin-events-hub-ongoing');
  assert.equal(events[0].url, 'https://www.kucoin.com/ru/campaigns/Campaign_Test_2026');
  assert.deepEqual(events[0].fields, [
    ['Объем пула', '200 000 USDT'],
    ['Заканчивается через', '5д 0ч 0м'],
  ]);
  assert(events[0].matchKeys.includes('kucoin:campaign:campaign_test_2026'));
});
