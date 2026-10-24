const BASE = 'https://assembly.webcast.go.kr/main';

/** Extract xcode/xcgcd from a player.asp URL. */
export function parsePlayerUrl(url) {
  const u = new URL(url);
  if (
    u.origin !== 'https://assembly.webcast.go.kr' ||
    u.pathname !== '/main/player.asp' ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new Error('Use an official Assembly player URL');
  const xcode = u.searchParams.get('xcode');
  const xcgcd = u.searchParams.get('xcgcd');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(xcode ?? '') || !/^[A-Za-z0-9_-]{1,100}$/.test(xcgcd ?? ''))
    throw new Error(`xcode/xcgcd not found in URL: ${url}`);
  return { xcode, xcgcd };
}

/** Fetch meeting metadata, including the AI subtitle WebSocket endpoint (xsami). */
export async function fetchMeeting({ xcode, xcgcd }) {
  const vv = Math.floor(Date.now() / 1000);
  const url = `${BASE}/service/live_play.asp?xcode=${encodeURIComponent(xcode)}&xcgcd=${encodeURIComponent(xcgcd)}&vv=${vv}&`;
  const res = await fetch(url, {
    headers: { Referer: `${BASE}/player.asp` },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`live_play.asp HTTP ${res.status}`);
  const data = await res.json();
  if (data.xcode === 'invalid-request') throw new Error('invalid-request: unknown meeting');
  return {
    xcode: data.xcode,
    xcgcd: data.xcgcd,
    committee: data.xfull,
    subject: data.xsubj,
    date: data.xdate,
    live: data.xstat === '1' || data.xstat === 1,
    smiServer: (data.xsami || '').trim(),
  };
}

/**
 * Resolve the WebSocket URL the site uses for AI subtitles on the HLS stream.
 * The site appends "/hls" for AI subtitle servers (see openos_util.js smi_on()).
 */
export function aiSubtitleUrl(smiServer) {
  if (!smiServer) throw new Error('This meeting has no subtitle server');
  if (/smi(-hy|-dw)?(\d)?\.webcast\.go\.kr/i.test(smiServer)) {
    throw new Error('This meeting uses stenographer subtitles (socket.io), not AI subtitles');
  }
  const url = new URL(smiServer);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname.endsWith('.webcast.go.kr') ||
    (url.port && url.port !== '8091') ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid Assembly subtitle server');
  return `${smiServer.replace(/\/$/, '')}/hls`;
}
