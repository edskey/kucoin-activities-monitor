const adapters = require('../sources');

const MAX_EVENTS = 500;

function validateEvent(event, sourceName) {
  if (!event || event.source !== sourceName || !event.id || !event.title || !event.url) {
    throw new Error(`Invalid event returned by ${sourceName}`);
  }
  return {
    source: String(event.source).slice(0, 100),
    id: String(event.id).slice(0, 1000),
    title: String(event.title).slice(0, 300),
    url: String(event.url).slice(0, 2000),
    fields: Array.isArray(event.fields)
      ? event.fields.slice(0, 30).map(([label, value]) => [String(label).slice(0, 100), String(value).slice(0, 500)])
      : [],
  };
}

async function main() {
  const results = await Promise.all(adapters.map(async (adapter) => {
    if (!adapter?.name || typeof adapter.collect !== 'function') throw new Error('Invalid source adapter');
    const events = await adapter.collect();
    if (!Array.isArray(events)) throw new Error(`${adapter.name} did not return an array`);
    return events.map((event) => validateEvent(event, adapter.name));
  }));
  const events = results.flat().slice(0, MAX_EVENTS);
  process.stderr.write(`Collected ${events.length} events from ${adapters.length} sources\n`);
  process.stdout.write(JSON.stringify({ sources: adapters.map((adapter) => adapter.name), events }));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
