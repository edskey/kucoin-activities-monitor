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
const promotions = [
  ['Торговый турнир BTC: награды активным трейдерам', '25 000 USDT', '2д 4ч 30м'],
  ['Кампания для новых пользователей KuCoin', '12 500 USDC', '5д 1ч 15м'],
  ['Фестиваль ETH: выполняйте задания и делите награды', '8 ETH (~31 200 USDT)', '18ч 45м'],
  ['Стейкинг KCS с дополнительным призовым пулом', '50 000 KCS (~475 000 USDT)', '6д 12ч'],
  ['Турнир фьючерсов SOL для сообщества', '40 000 USDT', '3д 8ч 5м'],
  ['Кампания Learn & Earn: изучайте Web3', '7 500 USDC', '11ч 20м'],
  ['Праздничная акция KuCoin Earn', '100 000 USDT', '9д 23ч 59м'],
  ['Спот-торговля: соревнование команд', '20 BTC (~1 300 000 USDT)', '1д 30м'],
  ['Бонусная кампания «Пригласи друга & получи награду»', '15 000 USDT', '4д 6ч 10м'],
  ['Финальная проверка мониторинга KuCoin', '30 000 USDC', '7д'],
];

const events = promotions.map(([title, pool, timer], index) => {
  const number = index + 1;
  return {
    source,
    id: `manual-test-${runId}-${number}`,
    title: `[ТЕСТ ${number}/10] ${title}`,
    url: 'https://www.kucoin.com/ru/announcement/activities',
    fields: [
      ['Объем пула', `${pool} (тестовые данные)`],
      ['Заканчивается через', `${timer} (тестовые данные)`],
    ],
  };
}).reverse();

process.stdout.write(JSON.stringify({ sources: [source], events }));
