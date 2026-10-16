const BASE = 'https://assembly.webcast.go.kr/main';

/** Extract xcode/xcgcd from a player.asp URL. */
export function parsePlayerUrl(url) {
  const u = new URL(url);
  const xcode = u.searchParams.get('xcode');
  const xcgcd = u.searchParams.get('xcgcd');
  if (!xcode || !xcgcd) throw new Error(`xcode/xcgcd not found in URL: ${url}`);
  return { xcode, xcgcd };
}

/** Fetch meeting metadata, including the AI subtitle WebSocket endpoint (xsami). */
export async function fetchMeeting({ xcode, xcgcd }) {
  const vv = Math.floor(Date.now() / 1000);
  const url = `${BASE}/service/live_play.asp?xcode=${encodeURIComponent(xcode)}&xcgcd=${encodeURIComponent(xcgcd)}&vv=${vv}&`;
  const res = await fetch(url, { headers: { Referer: `${BASE}/player.asp` } });
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
  return `${smiServer}/hls`;
}
