// Live broadcast catalog observed in the official main page script (main/js/main.js).
// This is a website contract, not a documented API; normalize defensively.
export const LIVE_LIST_URL = 'https://assembly.webcast.go.kr/main/service/live_list.asp';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BYTES = 1_000_000;
const MAX_ENTRIES = 500;
const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 500) : '');

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
        committee: text(item.xname),
        subject: text(item.xsubj),
        status: text(item.xdesc),
        live,
        url,
      };
    });
  return { checkedAt: text(data.qtime), broadcasts };
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
    if (!res.ok) throw new Error(`live_list.asp HTTP ${res.status}`);
    body = await res.text();
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Broadcast list request timed out');
    throw error;
  }
  if (body.length > MAX_BYTES) throw new Error('Broadcast list response is too large');
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
  let pending;
  return (refresh = false) => {
    if (pending) return pending;
    if (cached) {
      const age = now() - cached.at;
      if (age < (cached.error || refresh ? minRefresh : ttl))
        return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.value);
    }
    const at = now();
    pending = Promise.resolve()
      .then(load)
      .then(
        (list) => {
          cached = { at, value: { ...list, fetchedAt: at } };
          return cached.value;
        },
        (error) => {
          cached = { at, error };
          throw error;
        },
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
