const assert = require('node:assert/strict');
const test = require('node:test');
const handler = require('../api/check');

function responseCapture() {
  let status;
  let body;
  return {
    res: {
      status(value) { status = value; return this; },
      setHeader() {},
      end(value) { body = JSON.parse(value); },
    },
    result: () => ({ status, body }),
  };
}

function configureEnv() {
  Object.assign(process.env, {
    KUCOIN_CHECK_SECRET: 'secret',
    KUCOIN_UPSTASH_REDIS_REST_URL: 'https://redis.test',
    KUCOIN_UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    KUCOIN_TELEGRAM_BOT_TOKEN: 'bot-token',
    KUCOIN_TELEGRAM_CHAT_ID: '@channel',
  });
}

function event(id) {
  return {
    source: 'kucoin-activities-ongoing',
    id,
    title: `Акция ${id}`,
    url: `https://www.kucoin.com/ru/announcement/${id}`,
    fields: [['Объем пула', '10 000 USDT'], ['Заканчивается через', '1д 2ч 3м']],
  };
}

function redisTelegramMock(context, options = {}) {
  let state = options.initialState ?? null;
  let telegramAttempts = 0;
  const telegram = [];
  const redisKeys = [];
  context.mock.method(global, 'fetch', async (url, request = {}) => {
    if (String(url) === 'https://redis.test') {
      const command = JSON.parse(request.body);
      redisKeys.push(command[1]);
      if (command[0] === 'SET' && command.includes('NX')) return new Response(JSON.stringify({ result: 'OK' }));
      if (command[0] === 'GET') return new Response(JSON.stringify({ result: state && JSON.stringify(state) }));
      if (command[0] === 'SET') state = JSON.parse(command[2]);
      return new Response(JSON.stringify({ result: null }));
    }
    if (String(url).includes('/sendMessage')) {
      telegramAttempts += 1;
      if (options.failTelegramAttempt === telegramAttempts) {
        return new Response(JSON.stringify({ ok: false, description: 'temporary failure' }), { status: 500 });
      }
      telegram.push(JSON.parse(request.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  return { getState: () => state, telegram, redisKeys };
}

async function invoke(events) {
  const capture = responseCapture();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: { sources: ['kucoin-activities-ongoing'], events },
  }, capture.res);
  return capture.result();
}

test('rejects an invalid secret before external calls', async (context) => {
  process.env.KUCOIN_CHECK_SECRET = 'correct';
  context.mock.method(global, 'fetch', async () => { throw new Error('must not fetch'); });
  const capture = responseCapture();
  await handler({ method: 'POST', headers: { authorization: 'Bearer wrong' }, body: {} }, capture.res);
  assert.deepEqual(capture.result(), { status: 401, body: { error: 'unauthorized' } });
});

test('stores an empty first baseline and sends the first later card', async (context) => {
  configureEnv();
  const mocked = redisTelegramMock(context);
  assert.equal((await invoke([])).body.sent, 0);
  assert.deepEqual(mocked.getState().sources['kucoin-activities-ongoing'].sentIds, []);
  assert.equal((await invoke([event('first')])).body.sent, 1);
  assert.equal(mocked.telegram.length, 1);
});

test('baselines existing cards, sends new cards separately, and ignores timer changes', async (context) => {
  configureEnv();
  const mocked = redisTelegramMock(context);
  assert.equal((await invoke([event('old')])).body.sent, 0);
  const changedOld = event('old');
  changedOld.fields[1][1] = '0д 22ч 0м';
  assert.equal((await invoke([changedOld, event('one'), event('two')])).body.sent, 2);
  assert.equal(mocked.telegram.length, 2);
  assert(mocked.telegram.every((message) => message.parse_mode === 'HTML'));
  assert(mocked.telegram.every((message) => message.text.includes('Новая промоакция KuCoin')));
  assert(mocked.telegram.every((message) => message.text.includes('Объем пула')));
  assert.equal((await invoke([changedOld, event('one'), event('two')])).body.sent, 0);
  assert.equal(mocked.telegram.length, 2);
  assert(mocked.redisKeys.every((key) => String(key).startsWith('kucoin-activities-monitor:')));
});

test('checkpoints each accepted message and retries only the failed remainder', async (context) => {
  configureEnv();
  const initialState = { sources: { 'kucoin-activities-ongoing': { sentIds: ['old'] } } };
  const first = redisTelegramMock(context, { initialState, failTelegramAttempt: 2 });
  const failed = await invoke([event('old'), event('one'), event('two')]);
  assert.equal(failed.status, 500);
  assert.equal(first.telegram.length, 1);
  assert.deepEqual(first.getState().sources['kucoin-activities-ongoing'].sentIds, ['two', 'old']);

  context.mock.restoreAll();
  const second = redisTelegramMock(context, { initialState: first.getState() });
  const retried = await invoke([event('old'), event('one'), event('two')]);
  assert.equal(retried.body.sent, 1);
  assert.equal(second.telegram.length, 1);
  assert(second.telegram[0].text.includes('Акция one'));
});

test('rejects non-HTTPS links in scheduler payloads', async (context) => {
  configureEnv();
  context.mock.method(global, 'fetch', async () => { throw new Error('must not fetch'); });
  const unsafe = event('bad');
  unsafe.url = 'javascript:alert(1)';
  const result = await invoke([unsafe]);
  assert.deepEqual(result, { status: 400, body: { error: 'invalid_payload' } });
});
