# assembly-parser

국회 의사중계(`assembly.webcast.go.kr`) 생중계의 AI 자막을 수집해 5분 구간마다
요약하고, 내용을 주제별로 나눠 두 범주로 정리합니다. 범주는 관심 기관
(예: 한국교원대학교)과 그외입니다.

## 사용법

### 준비

- Node.js 22 이상
- [Claude Code](https://claude.com/claude-code) CLI(`claude`) 설치 및 로그인.
  모든 요약은 `claude -p`로 실행됩니다.

```bash
npm install
```

### 빠른 시작

명령마다 터미널을 따로 열어 실행합니다. `collect`는 회의 생중계가 시작되기
전에 띄워 두어야 합니다. 자막은 생중계 중에만 들어오고, 지난 자막은 받을 수
없습니다.

```bash
URL='https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=DCM00005822439A401&'

npm run collect -- "$URL"
npm run summarize -- "$URL" --focus 한국교원대학교 --focus-keywords 교원대,교원대학교
npm run serve -- "$URL"            # http://localhost:3000 접속
```

회의 내내 켜 두어야 하는 것은 `collect`뿐이고, `summarize`와 `serve`는 언제든
다시 시작해도 됩니다. `summarize`와 `serve`에는 URL 대신 xcgcd
(`DCM00005822439A401`)만 넘겨도 됩니다. 회의가 끝난 뒤
`npm run summarize -- "$URL" --once`를 실행하면 남은 구간을 처리하고 종료합니다.

### 명령

| 명령 | 옵션 |
|---|---|
| `collect <URL>` | `--data <dir>` (기본값 `data`) |
| `summarize <URL\|xcgcd>` | 아래 옵션과 `--data <dir>` |
| `serve <URL\|xcgcd>` | `--port <n>` (기본값 3000), `--data <dir>` |

#### summarize 옵션

- `--window <분>`: 구간 길이(기본값 5). 60의 약수로 지정합니다.
- `--focus <기관명>`: 범주를 `<기관명>` / `그외`로 나눕니다. 지정하지 않으면
  `전체` 하나입니다. `--focus-keywords`는 쉼표로 구분한 키워드 목록으로,
  자막에 키워드가 나오면 라우터에 힌트로 전달됩니다(공백 무시, 기본값은 기관명).
- `--rebuild`: 저장된 자막으로 처음부터 다시 요약합니다(`src/summarizer.js`의
  프롬프트를 고친 뒤 사용). 기존 주제는 삭제하지 않고
  `topics-archived-<시각>/`으로 옮깁니다. `--window`나 범주를 바꿔도 같은
  처리가 일어납니다.
- `--once`: 끝난 구간만 처리하고 종료합니다(예: 회의 종료 후).
- `--factcheck`: 의원 발언 속 사실 주장을 웹으로 확인합니다(아래 참고).
  웹 검색을 거치느라 주제당 15~30초쯤 걸려서 기본값은 꺼짐입니다.
- `--curate`: 새 기록이 들어왔으면 30분마다 전체 주제 목록을 검토해 병합,
  기록 이동, 제목 변경, 범주 수정 제안을 `curation.jsonl`에 남깁니다.
  제안만 기록하고 주제는 바꾸지 않습니다.

#### 모델

| 환경변수 | 용도 | 기본값 |
|---|---|---|
| `SUMMARY_MODEL` | 구간 요약, 주제 분류, 주제 요약 | `haiku` |
| `FACTCHECK_MODEL` | `--factcheck` | `sonnet` |
| `CURATE_MODEL` | `--curate` | `sonnet` |

### 웹 화면

- **왼쪽 열**: 구간 요약 카드가 최신순으로 쌓이고, 카드마다 그 구간에서 다룬
  주제가 칩으로 붙습니다. 새 자막은 SSE로 실시간 표시됩니다.
- **오른쪽 열**: 범주별 주제 목록. 주제를 열면 누적 요약, 팩트체크
  (`--factcheck` 사용 시), 구간별 기록이 나옵니다. 이어지는 구간의 기록은
  하나의 시간 범위로 합쳐 보여 줍니다.
- **필터**: 의원이나 기관 표시를 누르면 그 대상이 나온 주제만 보입니다.
  새로고침해도 유지되고, `Esc`로 해제합니다.
- **이미지로 공유**: 구간 카드와 열린 주제에 있는 버튼으로, 회의 정보와
  안내 문구를 넣은 PNG를 만듭니다. 터치 기기에서는 공유 시트를 열고,
  데스크톱에서는 클립보드에 복사하며, 둘 다 안 되면 파일로 내려받습니다.
- 상단에는 `summarize`가 실행 중인 Claude 호출이 표시됩니다.

### 개발

```bash
npm test
npm run lint      # Biome 린트·포맷 검사 (적용은 npm run lint:fix)
```

## 동작 방식

### 프로세스

독립된 세 프로세스가 `data/<xcgcd>/`를 함께 씁니다.

| 프로세스 | 읽기 | 쓰기 |
|---|---|---|
| `collect` | AI 자막 WebSocket | `meeting.json`, `transcript.jsonl` (추가만 함) |
| `summarize` | `meeting.json`, `transcript.jsonl` | `state.json`, `topics/*.json` + `topics/*.md`, `curation.jsonl` |
| `serve` | 위 파일 전부 | 없음 (웹 화면 `/`, JSON `/api/state`, 새 자막 SSE `/api/live`) |

### 구간 처리 순서

구간이 끝날 때마다 다음 순서로 처리합니다.

1. **구간 요약**: 왼쪽 열에 들어갈 요약. 직전 구간 요약을 맥락으로 씁니다.
2. **주제 분류**(1과 병렬): 라우터는 주제 목록(id, 범주, 제목, 설명), 직전
   구간의 항목, 자막을 받아 구간을 항목으로 나누고, 항목마다 기존 주제에 넣거나
   범주를 정해 새 주제를 만듭니다. `claude -p --json-schema`로 실행합니다.
3. 각 항목은 해당 주제의 그 구간 기록이 됩니다(`topics/tNNN.json`). 기록은
   추가만 되고, 같은 구간을 다시 처리할 때만 교체됩니다.
4. **주제 요약**: 새 기록이 생긴 주제는 저장된 요약에 새 기록만 더해 갱신합니다
   (`summary.until`에 반영 시점 기록). 최대 4개를 병렬로 처리하며, 회의 전체를
   다시 보내지 않습니다.
5. **팩트체크**(`--factcheck`): 위 단계를 늦추지 않도록 별도 루프에서 돕니다.
   의원이 발언한 새 기록이 있는 주제마다 확인 가능한 사실 주장(수치, 사건, 법령,
   예산)을 3개까지 골라 웹에서 확인하고, 판정·설명·출처를 `topic.factcheck`에
   저장합니다. `논쟁 중`인 주장은 입장별 견해와 출처를 따로 적습니다. 이전 확인
   결과를 함께 넘겨 같은 주장을 두 번 확인하지 않습니다. 도구는
   `WebSearch`/`WebFetch`만 씁니다.

구간은 순서대로 처리합니다. 구간마다 직전 구간과 그때까지 만든 주제 목록을
쓰기 때문입니다. 3번 실패한 구간은 뒤 구간이 막히지 않도록 건너뛰고,
`summarize`를 다시 시작하면 재시도합니다.

요약은 로컬 Claude Code CLI(`claude -p`, 도구 비활성, 세션 저장 안 함)로
실행합니다. 실행 중인 호출은 `state.json`의 `running`에 summarize pid와 함께
기록되므로, 프로세스가 강제 종료돼도 오래된 항목이 남지 않습니다.

### 자막 프로토콜

`live_play.asp?xcode=…&xcgcd=…`는 자막 서버 주소 `xsami`를 돌려줍니다
(예: `wss://smiai.webcast.go.kr:8091/aistt/gyoyuk`). 수집기는 사이트의
`openos_util.js`와 같은 방식으로 `${xsami}/hls`에 서브프로토콜
`echo-protocol`로 접속합니다. 프레임에는 `segment`, `segment-offset`,
`transcript`, `transcripts`(화자 분리, `-` 접두어는 화자 바뀜), `final`이
들어 있습니다. `final`인 프레임만 저장하고, 같은 segment의 `final`이 나중에
다시 오면 읽을 때 이전 것을 대체합니다.
