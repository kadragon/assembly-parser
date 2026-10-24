// Live broadcast catalog observed in the official main page script (main/js/main.js).
// This is a website contract, not a documented API; normalize defensively.
export const LIVE_LIST_URL = 'https://assembly.webcast.go.kr/main/service/live_list.asp';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BYTES = 1_000_000;
const MAX_ENTRIES = 500;
const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 500) : '');
const entities = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};
// main.js renders these fields as HTML; show them as plain text instead.
const plain = (value) =>
  text(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});/gi, (entity, code) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => entities[entity])
    .trim();

/** Normalize live_list.asp JSON; reject shapes that cannot be told apart from an empty list. */
export function normalizeLiveList(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.xlist))
    throw new Error('Malformed broadcast list');
  if (data.xlist.length > MAX_ENTRIES)
    throw new Error('Malformed broadcast list: too many entries');
  const broadcasts = data.xlist
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const xcode = text(item.xcode);
      const xcgcd = text(item.xcgcd);
      const live = item.xstat === '1' || item.xstat === 1;
      // Like main.js, only a live entry with a meeting identifier links to a player.
      const url =
        live && ID.test(xcode) && ID.test(xcgcd)
          ? `https://assembly.webcast.go.kr/main/player.asp?xcode=${xcode}&xcgcd=${xcgcd}`
          : null;
      return {
        xcode,
        xcgcd,
        committee: plain(item.xname),
        subject: plain(item.xsubj),
        status: plain(item.xdesc),
        live,
        url,
      };
    });
  return { checkedAt: text(data.qtime), broadcasts };
}

/** Read at most MAX_BYTES; leaving the loop early cancels the rest of the stream. */
async function readBounded(res) {
  const tooLarge = () => new Error('Broadcast list response is too large');
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  // TextDecoder strips a leading BOM, as res.json() would.
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export async function fetchLiveList({ fetchImpl = fetch, timeout = 10000 } = {}) {
  let res;
  let body;
  try {
    res = await fetchImpl(`${LIVE_LIST_URL}?vv=${Math.floor(Date.now() / 1000)}&`, {
      headers: { Referer: 'https://assembly.webcast.go.kr/main/' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`live_list.asp HTTP ${res.status}`);
    }
    body = await readBounded(res);
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Broadcast list request timed out');
    throw error;
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Malformed broadcast list');
  }
  return normalizeLiveList(data);
}

/** Cache the list, share in-flight lookups, and keep manual refresh from hammering upstream. */
export function createCatalog(load, { ttl = 30000, minRefresh = 5000, now = Date.now } = {}) {
  let cached;
  let failure;
  let pending;
  return (refresh = false) => {
    if (pending) return pending;
    const at = now();
    const fresh = (limit) => cached && at - cached.fetchedAt < limit;
    if (fresh(refresh ? minRefresh : ttl)) return Promise.resolve(cached);
    // A failed lookup pauses retries but never hides a list that is still within its TTL.
    if (failure && at - failure.at < minRefresh)
      return fresh(ttl) ? Promise.resolve(cached) : Promise.reject(failure.error);
    pending = Promise.resolve()
      .then(load)
      .then(
        // Stamp on settle: a lookup that hung until its timeout must still pause retries.
        (list) => {
          cached = { ...list, fetchedAt: now() };
          failure = null;
          return cached;
        },
        (error) => {
          failure = { at: now(), error };
          throw error;
        },
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
