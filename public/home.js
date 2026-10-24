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
      el('div', `${session.meeting.committee} · ${session.meeting.date ?? ''}`, 'meta'),
      el('h3', session.meeting.subject),
    );
    const statuses = el('div', '', 'statuses');
    statuses.append(
      el('span', `수집 · ${labels[session.collection] ?? session.collection}`, 'badge'),
      el('span', `요약 · ${labels[session.summary] ?? session.summary}`, 'badge'),
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
    if (session.collection !== 'running' && session.config)
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
    for (const [action, title] of session.collection === 'running'
      ? [
          ['stop', '중지'],
          ['retry', '요약 재시도'],
        ]
      : [
          ['resume', '수집 재개'],
          ['retry', '요약 재시도'],
          ['finalize', '마지막 구간 마무리'],
        ]) {
      if (!session.config && action !== 'stop') continue;
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
