import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalog, fetchLiveList, LIVE_LIST_URL, normalizeLiveList } from '../src/catalog.js';
import { parsePlayerUrl } from '../src/meeting.js';

const entry = (fields) => ({
  xcode: '58',
  xcgcd: '',
  xname: '교육위',
  xstat: '0',
  xsubj: '',
  xdesc: '생중계 없음',
  xsami: '1',
  ...fields,
});

test('live list normalization keeps committee, subject, status and only selectable live entries', () => {
  const list = normalizeLiveList({
    qtime: '2026-10-24 10:00:00',
    xlist: [
      entry({
        xcgcd: 'DCM0000158',
        xstat: '1',
        xsubj: '<b>제1차</b> 회의 &amp; 질의',
        xdesc: '교육위 개의',
      }),
      entry({ xcode: '10', xname: '본회의', xstat: 1, xcgcd: '' }),
      entry({ xcode: '25', xname: '법사위', xcgcd: 'DCM9', xdesc: '법사위 정회' }),
      entry({ xcode: '../x', xstat: '1', xcgcd: 'DCM1' }),
      entry({ xcode: '26', xstat: '1', xcgcd: 'a&b' }),
      'not an entry',
      null,
      { xcode: '91', xname: '특별위', xstat: '', xdesc: '생중계 없음' },
    ],
  });
  assert.equal(list.checkedAt, '2026-10-24 10:00:00');
  assert.deepEqual(list.broadcasts[0], {
    xcode: '58',
    xcgcd: 'DCM0000158',
    committee: '교육위',
    subject: '제1차 회의 & 질의',
    status: '교육위 개의',
    live: true,
    url: 'https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=DCM0000158',
  });
  assert.deepEqual(parsePlayerUrl(list.broadcasts[0].url), { xcode: '58', xcgcd: 'DCM0000158' });
  // Live without a meeting identifier cannot be started from the list.
  assert.equal(list.broadcasts[1].live, true);
  assert.equal(list.broadcasts[1].url, null);
  assert.equal(list.broadcasts[2].live, false);
  assert.equal(list.broadcasts[2].url, null);
  assert.equal(list.broadcasts[3].committee, '교육위');
  assert.equal(list.broadcasts[3].url, null);
  assert.equal(list.broadcasts[4].url, null);
  assert.equal(list.broadcasts.length, 6);
  assert.equal(list.broadcasts[5].committee, '특별위');
  assert.equal(list.broadcasts[5].subject, '');
});

test('malformed live list responses are rejected instead of reported as empty', () => {
  for (const data of [null, [], 'x', {}, { xlist: 'x' }, { xlist: Array(501).fill(entry({})) }])
    assert.throws(() => normalizeLiveList(data), /Malformed broadcast list/);
  assert.deepEqual(normalizeLiveList({ xlist: [] }).broadcasts, []);
});

test('live list fetch uses only the fixed endpoint, rejects redirects, HTTP errors and oversized bodies', async () => {
  const calls = [];
  const respond = (body, init) => async (url, options) => {
    calls.push({ url, options });
    return new Response(body, init);
  };
  const list = await fetchLiveList({ fetchImpl: respond(JSON.stringify({ xlist: [entry({})] })) });
  assert.equal(list.broadcasts.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, LIVE_LIST_URL);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);
  await assert.rejects(fetchLiveList({ fetchImpl: respond('', { status: 500 }) }), /HTTP 500/);
  await assert.rejects(fetchLiveList({ fetchImpl: respond('not json') }), /Malformed/);
  await assert.rejects(fetchLiveList({ fetchImpl: respond(' '.repeat(1_000_001)) }), /too large/);
  // A body larger than the limit is cancelled while streaming, not buffered in full.
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(fetchLiveList({ fetchImpl: respond(endless) }), /too large/);
  assert.ok(cancelled && pulled < 40, `stream pulled ${pulled} chunks`);
  await assert.rejects(
    fetchLiveList({ fetchImpl: respond('{}', { headers: { 'Content-Length': '2000000' } }) }),
    /too large/,
  );
  const hang = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  await assert.rejects(fetchLiveList({ fetchImpl: hang, timeout: 20 }), /timed out|TimeoutError/i);
});

test('catalog cache shares requests, rate-limits manual refresh and retries failures after a pause', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const catalog = createCatalog(
    async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error('upstream down');
      return { checkedAt: String(calls), broadcasts: [] };
    },
    { ttl: 30000, minRefresh: 5000, now: () => clock },
  );
  const [a, b] = await Promise.all([catalog(), catalog(true)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.fetchedAt, 0);
  clock = 4000;
  await catalog(true);
  assert.equal(calls, 1, 'refresh within the minimum interval reuses the cached list');
  clock = 6000;
  await catalog();
  assert.equal(calls, 1, 'plain reads reuse the list until the TTL expires');
  assert.equal((await catalog(true)).checkedAt, '2');
  fail = true;
  clock = 40000;
  await assert.rejects(catalog(), /upstream down/);
  await assert.rejects(catalog(true), /upstream down/);
  assert.equal(calls, 3, 'a failure is not retried before the minimum interval');
  fail = false;
  clock = 46000;
  assert.equal((await catalog()).checkedAt, '4');
});

test('a failed manual refresh keeps serving the cached list until its TTL expires', async () => {
  let clock = 0;
  let fail = false;
  const catalog = createCatalog(
    async () => {
      if (fail) throw new Error('upstream down');
      return { checkedAt: 'ok', broadcasts: [] };
    },
    { ttl: 30000, minRefresh: 5000, now: () => clock },
  );
  await catalog();
  fail = true;
  clock = 10000;
  await assert.rejects(catalog(true), /upstream down/);
  clock = 12000;
  assert.equal((await catalog()).checkedAt, 'ok');
  assert.equal((await catalog(true)).checkedAt, 'ok');
  clock = 31000;
  await assert.rejects(catalog(), /upstream down/);
});
