const form = document.querySelector('#start-form');
const message = document.querySelector('#message');
const container = document.querySelector('#sessions');
let token;
let lastRender = '';
const labels = {
  running: '진행 중',
  starting: '시작 중',
  queued: '대기 중',
  idle: '다음 구간 대기',
  stopped: '중지됨',
  interrupted: '비정상 종료',
  error: '오류',
  complete: '마무리 완료',
  stale: '다시 만들기 필요',
  imported: '파일 업로드됨',
};
// Uploaded files are complete recordings: no live collection, gaps, resume or finalize.
const uploaded = (session) => session.meeting.profile === 'general';
const elapsed = (ms) => {
  const m = Math.floor(ms / 60000);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const time = (value) => new Date(value).toLocaleString('ko-KR');
function el(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
async function perform(button, fn) {
  button.disabled = true;
  message.textContent = '요청을 처리하고 있습니다…';
  try {
    await fn();
    message.textContent = '처리했습니다.';
    await refresh();
  } catch (error) {
    message.textContent = `처리하지 못했습니다: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}
function render(sessions) {
  const signature = JSON.stringify(sessions);
  if (lastRender === signature) return;
  lastRender = signature;
  container.replaceChildren();
  document.querySelector('#count').textContent = String(sessions.length).padStart(2, '0');
  if (!sessions.length)
    container.append(
      el('p', '아직 저장된 기록이 없습니다.\n첫 회의의 주소를 입력해 보세요.', 'empty'),
    );
  for (const session of sessions) {
    const card = el('article', '', 'session');
    card.append(
      el(
        'div',
        uploaded(session)
          ? `업로드한 자막 · 길이 ${elapsed(session.meeting.duration ?? 0)} · 자막 ${session.meeting.cues ?? 0}개`
          : `${session.meeting.committee} · ${session.meeting.date ?? ''}`,
        'meta',
      ),
      el('h3', session.meeting.subject),
    );
    const statuses = el('div', '', 'statuses');
    statuses.append(
      el('span', `수집 · ${labels[session.collection] ?? session.collection}`, 'badge'),
      el(
        'span',
        `요약 · ${uploaded(session) && session.summary === 'complete' ? '완료' : (labels[session.summary] ?? session.summary)}`,
        'badge',
      ),
    );
    card.append(statuses);
    if (session.config)
      card.append(
        el(
          'p',
          `${session.config.windowMinutes}분 간격 · ${session.config.focus || '전체 요약'}`,
          'meta',
        ),
      );
    if (session.config?.focusKeywords)
      card.append(el('p', `키워드: ${session.config.focusKeywords}`, 'meta'));
    if (session.config?.focusNote)
      card.append(el('p', `관심 범위: ${session.config.focusNote}`, 'meta'));
    if (session.gap)
      card.append(
        el(
          'p',
          `${time(session.gap.from)} ~ ${time(session.gap.to)}: 수집이 중단된 구간의 자막은 복구할 수 없습니다.`,
          'notice',
        ),
      );
    else if (session.missedSince)
      card.append(
        el(
          'p',
          `${time(session.missedSince)} 이후 수집이 멈췄습니다. 재개 전까지의 자막은 저장되지 않습니다.`,
          'notice',
        ),
      );
    for (const key of ['collectionError', 'summaryError'])
      if (session[key]) card.append(el('p', session[key], 'error'));
    if (session.summary === 'stale')
      card.append(
        el(
          'p',
          `저장된 요약이 현재 자막이나 설정과 맞지 않아 요약을 멈췄습니다. 수집은 계속됩니다. 다시 만들면 이전 요약과 주제 기록은 보관함으로 옮겨집니다.\n${session.staleReasons ?? ''}`,
          'notice',
        ),
      );
    if (session.lastArchive)
      card.append(el('p', `이전 요약 보관 위치: ${session.id}/${session.lastArchive}`, 'hint'));
    if (!session.config)
      card.append(
        el(
          'p',
          '설정이 저장되지 않은 이전 기록입니다. 기록은 그대로 볼 수 있고, 다시 만들면 기존 요약 간격과 관심 기관을 사용합니다.',
          'hint',
        ),
      );
    if (session.collection !== 'running' && session.config && !uploaded(session))
      card.append(
        el(
          'p',
          `마지막 구간 마무리는 회의 기록을 끝낼 때 사용하세요. 마무리한 ${session.config.windowMinutes}분 구간이 끝나기 전에는 수집을 재개할 수 없습니다.`,
          'hint',
        ),
      );
    const actions = el('div', '', 'actions');
    const link = el('a', '기록 열기 ↗');
    link.href = `/sessions/${encodeURIComponent(session.id)}/`;
    actions.append(link);
    const rebuildable = session.summary === 'stale' || !session.config;
    const busy = ['running', 'queued'].includes(session.summary);
    for (const [action, title] of [
      ...(uploaded(session)
        ? [busy ? ['stop', '요약 중지'] : ['retry', '요약 재시도']]
        : session.collection === 'running'
          ? [
              ['stop', '중지'],
              ['retry', '요약 재시도'],
            ]
          : [
              ['resume', '수집 재개'],
              ['retry', '요약 재시도'],
              ['finalize', '마지막 구간 마무리'],
            ]),
      ...(rebuildable ? [['rebuild', '요약 다시 만들기']] : []),
    ]) {
      if (!session.config && !['stop', 'rebuild'].includes(action)) continue;
      const button = el('button', title);
      button.type = 'button';
      button.addEventListener('click', () =>
        perform(button, () =>
          post(`/api/sessions/${encodeURIComponent(session.id)}/${action}`, {}),
        ),
      );
      actions.append(button);
    }
    card.append(actions);
    container.append(card);
  }
}
async function refresh() {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error('서버 연결을 확인해 주세요.');
  const data = await res.json();
  token = data.token;
  render(data.sessions);
  const warnings = document.querySelector('#warnings');
  warnings.replaceChildren(
    ...(data.warnings ?? []).map((warning) =>
      el('p', `읽지 못한 기록이 있습니다. 원본 파일을 확인해 주세요: ${warning}`, 'notice'),
    ),
  );
}
const catalogStatus = document.querySelector('#catalog-status');
const catalogList = document.querySelector('#catalog-list');
const refreshButton = document.querySelector('#catalog-refresh');
const urlInput = document.querySelector('#url');
let broadcasts = [];
function renderCatalog() {
  catalogList.replaceChildren();
  // Committees without any broadcast today only add noise.
  const shown = broadcasts.filter((item) => item.live || item.xcgcd);
  for (const item of shown) {
    const row = el('li');
    if (item.url && item.url === urlInput.value) row.className = 'selected';
    const info = el('div');
    info.append(
      el('strong', `${item.committee}${item.subject ? ` · ${item.subject}` : ''}`),
      el('span', item.live ? `생중계 · ${item.status}` : item.status || '중계 대기', 'meta'),
    );
    row.append(info);
    if (item.url) {
      const choose = el('button', '선택');
      choose.type = 'button';
      choose.addEventListener('click', () => {
        urlInput.value = item.url;
        message.textContent = `${item.committee} 회의를 선택했습니다. 관심 주제를 정한 뒤 시작하세요.`;
        renderCatalog();
        document.querySelector('#focus').focus();
      });
      row.append(choose);
    } else if (item.live) row.append(el('span', '회의 정보가 없어 선택할 수 없음', 'meta'));
    catalogList.append(row);
  }
  return shown.filter((item) => item.live).length;
}
async function loadCatalog(refresh = false) {
  refreshButton.disabled = true;
  catalogStatus.textContent = '목록을 불러오고 있습니다…';
  try {
    const res = await fetch(`/api/catalog${refresh ? '?refresh=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    broadcasts = data.broadcasts;
    const live = renderCatalog();
    const checked = `확인 ${time(data.fetchedAt)}`;
    catalogStatus.textContent = live
      ? `${live}개 회의가 생중계 중입니다. ${checked}`
      : `지금은 생중계 중인 회의가 없습니다. ${checked}`;
  } catch (error) {
    // Keep a list that already loaded; only the refresh failed.
    catalogStatus.textContent = broadcasts.length
      ? `목록을 새로 고치지 못해 이전 목록을 표시합니다. (${error.message})`
      : `생중계 목록을 불러오지 못했습니다. 주소를 직접 입력할 수 있습니다. (${error.message})`;
  } finally {
    refreshButton.disabled = false;
  }
}
refreshButton.addEventListener('click', () => loadCatalog(true));
urlInput.addEventListener('input', () => renderCatalog());
loadCatalog();
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(form));
  const { url, ...config } = fields;
  config.windowMinutes = Number(config.windowMinutes);
  perform(form.querySelector('button'), () => post('/api/start', { url, config }));
});
const uploadForm = document.querySelector('#upload-form');
const fileInput = document.querySelector('#file');
// The file name only suggests a title and ID; the server never uses it as a path.
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  const stem = file.name.replace(/\.[^.]*$/, '');
  const title = document.querySelector('#title');
  const id = document.querySelector('#session-id');
  if (!title.value) title.value = stem.slice(0, 200);
  if (!id.value)
    id.value =
      stem
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || `upload-${new Date().toISOString().slice(0, 10)}`;
});
uploadForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  const fields = Object.fromEntries(new FormData(uploadForm));
  perform(uploadForm.querySelector('button'), async () => {
    if (file.size > 5 * 1024 * 1024) throw new Error('파일이 5MB보다 큽니다.');
    let content;
    try {
      // file.text() would turn a non-UTF-8 file into replacement characters and accept it
      content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error('UTF-8 파일이 아닙니다. UTF-8로 저장한 뒤 다시 올려 주세요.');
    }
    await post('/api/upload', {
      id: fields.id,
      title: fields.title,
      config: { windowMinutes: Number(fields.windowMinutes) },
      content,
    });
    uploadForm.reset();
  });
});
refresh().catch((error) => {
  message.textContent = error.message;
});
setInterval(
  () =>
    refresh().catch(() => {
      message.textContent = '서버와 연결이 끊겼습니다. 실행 중인 터미널을 확인해 주세요.';
    }),
  2000,
);
