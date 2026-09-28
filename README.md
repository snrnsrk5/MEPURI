# 메푸리 (MEPURI)

메이플스토리 일간·주간·월간 보스 관리 사이트 — 테스트 버전.

Cloudflare Worker 하나가 사이트(`public/`)와 캐릭터 조회 API(`/api/…`)를 같은 주소에서 같이 보여줘요.
넥슨 Open API 키는 Cloudflare 비밀값에만 있고, 사이트에서는 캐릭터 이름만 보내서 조회해요.

## 파일 구성

```
public/index.html   메푸리 화면 (테스트 웹)
worker.js           /api/ 주소 처리 — 넥슨 Open API 대신 불러주기
wrangler.toml       Cloudflare 배포 설정 (Worker 이름: mepuri)
```

## Cloudflare에 올리기 (처음 한 번)

1. Cloudflare 대시보드 → **Workers & Pages** → 만들기 → **저장소 가져오기(Import a repository)** → GitHub 연결 → `snrnsrk5/mepuri` 선택.
2. 프로젝트(Worker) 이름은 꼭 **`mepuri`**로 해 주세요. `wrangler.toml`의 이름과 다르면 배포가 실패해요.
   배포 명령은 기본값(`npx wrangler deploy`) 그대로 두면 돼요.
3. 배포가 끝나면 Worker의 **설정 → 변수 및 비밀**에서 **비밀(Secret)**을 추가해요.
   - 이름: `NEXON_API_KEY`
   - 값: openapi.nexon.com에서 받은 API 키 (여기에만 넣고, 코드·GitHub·채팅에는 적지 마세요)
4. `https://mepuri.○○○.workers.dev`를 열면 메푸리 화면이 나와요.
   캐릭터 추가에서 이름만 넣으면 실제로 조회돼요. (따로 설정할 것 없음)
   - 서버 확인: 주소 뒤에 `/api/health` → `{"ok":true,"service":"mepuri-api"}`

이후로는 GitHub에 파일을 올릴(커밋할) 때마다 자동으로 다시 배포돼요.

## API 주소

| 주소 | 하는 일 |
|---|---|
| `GET /api/health` | 서버 확인 |
| `GET /api/character?name=캐릭터명` | 이름 → ocid → 월드·레벨·직업·외형 이미지 |
| `GET /api/character/basic?ocid=…` | 저장해 둔 ocid로 다시 불러오기 (새로고침) |
| `GET /api/scheduler?ocid=…` | 인게임 스케줄러(보스 완료 여부). 나중에 자동 클리어 체크용 |

응답 예시 (`/api/character`):

```json
{ "ocid": "…", "name": "렌코덱", "world": "베라", "level": 290, "job": "렌",
  "image": "https://open.api.nexon.com/static/maplestory/character/look/…",
  "guild": null, "date": null }
```

오류는 넥슨과 같은 모양으로 돌려줘요: `{ "error": { "name": "OPENAPI00004", "message": "…" } }`

## 알아둘 것

- **호출 한도:** 개발 단계 키는 초당 5건, 하루 1,000건이에요.
  서비스를 열 때는 넥슨 Open API에서 서비스 단계로 전환을 신청해야 해요.
- **다른 사이트에서 부르기:** 지금은 누구나 `/api/`를 부를 수 있어요.
  막으려면 `wrangler.toml`의 `ALLOWED_ORIGINS`에 허용할 주소를 넣어요
  (대시보드에서 바꾸면 다음 배포 때 이 파일 값으로 덮어써져요).
- **캐시:** 같은 이름은 하루, 기본 정보는 10분 동안 기억해서 호출을 아껴요.
  `workers.dev` 주소에서는 캐시가 저장되지 않고 내 도메인을 연결했을 때만 동작해요. 캐시가 안 돼도 조회는 정상이에요.
- **데이터 갱신:** 넥슨 정책상 API로 받은 데이터는 30일 안에 다시 갱신해야 해요. DB를 붙일 때 불러온 날짜를 같이 저장해 두세요.
- **출처 표시:** 사이트에 `Data based on NEXON Open API` 문구를 꼭 표시해야 해요 (화면 왼쪽 아래에 넣어 둠).
