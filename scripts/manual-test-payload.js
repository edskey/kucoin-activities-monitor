const source = 'kucoin-manual-test';
const mode = process.argv[2];

if (mode === 'baseline') {
  process.stdout.write(JSON.stringify({ sources: [source], events: [] }));
  process.exit(0);
}

if (mode !== 'messages') {
  process.stderr.write('Usage: node scripts/manual-test-payload.js baseline|messages\n');
  process.exit(1);
}

const runId = String(process.env.TEST_RUN_ID || Date.now()).replace(/[^a-z0-9_-]/gi, '').slice(0, 100);
const event = (number) => ({
  source,
  id: `manual-test-${runId}-${number}`,
  title: `[ТЕСТ ${number}/2] Проверка доставки уведомлений KuCoin`,
  url: 'https://www.kucoin.com/ru/announcement/activities',
  fields: [
    ['Объем пула', '10 000 USDT (тестовые данные)'],
    ['Заканчивается через', '1д 2ч 3м (тестовые данные)'],
  ],
});

process.stdout.write(JSON.stringify({ sources: [source], events: [event(1), event(2)] }));
