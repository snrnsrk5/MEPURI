# 메푸리 API 서버 (Cloudflare Worker)

넥슨 Open API 키를 서버에만 두고, 사이트는 캐릭터 이름만 보내서 조회하게 해 주는 작은 서버예요.
사용자는 키를 볼 일이 없어요.

## 올리는 방법 (대시보드에서, 설치 없음)

1. Cloudflare에 가입하고 **Workers & Pages**에서 새 Worker를 만들어요. 이름은 `mepuri-api`로 해 주세요.
   처음 나오는 "Hello World" 예제를 그대로 **배포**해요.
2. 만든 Worker에서 **코드 편집**을 열고, 안의 내용을 전부 지운 다음 `worker.js` 내용을 붙여넣고 **배포**해요.
3. Worker의 **설정 → 변수 및 비밀**에서 **비밀(Secret)**을 하나 추가해요.
   - 이름: `NEXON_API_KEY`
   - 값: openapi.nexon.com에서 받은 API 키
   - 키는 여기에만 넣고, 코드나 채팅에는 적지 마세요.
4. Worker 주소(`https://mepuri-api.○○○.workers.dev`)를 브라우저로 열어 보세요.
   `{"ok":true,"service":"mepuri-api"}`가 보이면 성공이에요.
5. 주소 뒤에 `/api/character?name=캐릭터명`을 붙여 열면 실제 조회 결과가 나와요.
6. 테스트 웹 상단의 **테스트 설정**을 열고, **메푸리 API 서버 주소**에 Worker 주소를 넣은 다음 **연결 확인**을 눌러요.
   이제 캐릭터 추가에서 이름만 넣으면 조회돼요.

## 주소

| 주소 | 하는 일 |
|---|---|
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

- **허용 사이트 제한:** 사이트 주소가 정해지면 `ALLOWED_ORIGINS` 변수(일반 변수)에 넣어 주세요.
  예: `https://mepuri.pages.dev`. 다른 사이트가 내 서버로 조회하지 못하게 막아요.
  비워두면 어디서든 부를 수 있어요 (테스트용).
- **호출 한도:** 개발 단계 키는 초당 5건, 하루 1,000건이에요.
  서비스를 열 때는 넥슨 Open API에서 서비스 단계로 전환을 신청해야 해요.
- **캐시:** 같은 이름은 하루, 기본 정보는 10분 동안 기억해서 호출을 아껴요.
  단, `workers.dev` 주소에서는 캐시가 저장되지 않고, 내 도메인을 연결했을 때만 동작해요. 캐시가 안 돼도 조회는 정상이에요.
- **데이터 갱신:** 넥슨 정책상 API로 받은 데이터는 30일 안에 다시 갱신해야 해요.
  DB를 붙일 때 불러온 날짜를 같이 저장해 두세요.
- **출처 표시:** 사이트에 `Data based on NEXON Open API` 문구를 꼭 표시해야 해요. 테스트 웹에는 왼쪽 아래에 넣어 뒀어요.

## 나중에 GitHub로 옮길 때

`worker.js`와 `wrangler.toml`을 저장소에 올리고 Cloudflare에서 그 저장소를 연결하면, 푸시할 때마다 자동으로 배포돼요.
키는 그때도 Cloudflare 비밀값으로만 넣어요 (`npx wrangler secret put NEXON_API_KEY`).
