# 메푸리 (MEPURI)

메이플스토리 일간·주간·월간 보스 관리 사이트 — 테스트 버전.

Cloudflare Worker 하나가 사이트(`public/`)와 캐릭터 조회 API(`/api/…`)를 같은 주소에서 같이 보여줘요.
넥슨 Open API 키는 Cloudflare 비밀값에만 있고, 사이트에서는 캐릭터 이름만 보내서 조회해요.

## 파일 구성

```
public/index.html   메푸리 화면
worker.js           /api/ 주소 처리 — 넥슨 Open API 대신 불러주기 + 구글 로그인 + 기록 저장
wrangler.toml       Cloudflare 배포 설정 (Worker 이름: mepuri, D1 데이터베이스 연결)
schema.sql          데이터베이스 표 구조 (참고용, Worker가 자동으로 만듦)
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

## 구글 로그인 + 기록 저장 켜기 (처음 한 번)

로그인하면 캐릭터·보스 설정·클리어 기록이 계정에 저장돼서 다른 기기에서도 이어서 쓸 수 있어요.
아래 설정을 안 하면 로그인 버튼만 안 보이고, 나머지는 전처럼 이 브라우저에만 저장돼요.

캐릭터 조회(이름 찾기 · 새로고침)는 **구글 로그인한 사람만** 할 수 있어요. 로그인 설정을 안 하면 이 사이트 서버로는 캐릭터를 찾을 수 없어요.

**1. D1 데이터베이스 만들기 (Cloudflare)**
1. Cloudflare 대시보드 → **Storage & Databases → D1 SQL Database** → **Create** → 이름 `mepuri` → 만들기.
2. 만든 데이터베이스 화면에 보이는 **Database ID**(긴 영문·숫자)를 복사해요.
3. `wrangler.toml` 맨 아래 `database_id = "…"` 따옴표 안에 붙여넣어요. (표는 Worker가 알아서 만들어요)

**2. 구글 로그인 클라이언트 ID 만들기 (Google Cloud)**
1. https://console.cloud.google.com 에서 새 프로젝트를 만들어요 (이름 예: mepuri).
2. **API 및 서비스 → OAuth 동의 화면**: 외부(External) 선택 → 앱 이름 `메푸리`, 지원 이메일, 개발자 연락처 입력 → 저장.
   범위(Scopes)는 따로 추가하지 않아도 돼요 (이름·이메일·프로필 사진만 씀).
3. 동의 화면의 **게시 상태**를 **프로덕션으로 게시(Publish app)** 로 바꿔요.
   테스트 상태로 두면 테스트 사용자로 등록한 계정만 로그인돼요. (이름·이메일만 쓰면 구글 심사는 필요 없어요)
4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - **승인된 JavaScript 원본**: `https://mepuri.bosslog.workers.dev` (내 도메인을 붙이면 그 주소도 추가)
   - 동의 화면(브랜딩)의 홈페이지 `https://mepuri.bosslog.workers.dev`, 개인정보처리방침 `https://mepuri.bosslog.workers.dev/privacy.html`, 승인된 도메인 `bosslog.workers.dev`도 같은 주소로 맞춰요.
   - 사이트 주소(Cloudflare 계정 서브도메인)를 바꾸면 위 칸들도 모두 새 주소로 바꿔야 로그인이 돼요.
   - 리디렉션 URI는 비워둬도 돼요.
5. 만들어진 **클라이언트 ID**(`…apps.googleusercontent.com`)를 복사해요.

**3. Worker에 넣기**
- Worker → **설정 → 변수 및 비밀** → 비밀(Secret) 추가: 이름 `GOOGLE_CLIENT_ID`, 값 = 위에서 복사한 클라이언트 ID.
  (클라이언트 ID는 공개돼도 괜찮은 값이지만, 비밀로 넣어야 배포할 때 지워지지 않아요)

**4. 확인**
- 주소 뒤에 `/api/config` → `{"auth":true, ...}` 가 나오면 준비 끝. 사이트 오른쪽 위에 **로그인** 버튼이 생겨요.

### 저장 방식
- 로그인 쿠키는 스크립트가 읽을 수 없는 방식(HttpOnly)이고 30일 유지돼요. 데이터베이스에는 쿠키 값 대신 해시만 저장해요.
- 기록은 고친 뒤 1초쯤 지나 자동으로 계정에 저장돼요. 오른쪽 위 프로필 옆 점: 초록 = 저장됨, 노랑 = 저장 중, 빨강 = 실패·겹침.
- 두 기기에서 동시에 고치면 두 기록을 나란히 보여 주고 어느 쪽을 쓸지 골라요 (몰래 덮어쓰지 않음). 고르지 않은 쪽은 이 기기에 30일 동안 백업돼요 (프로필 메뉴 → 백업에서 되돌리기).
- 로그아웃한 채로 고친 기록은 다시 로그인할 때 늘 물어봐요. 화면 상태(탭·보는 날짜 등)는 기기마다 따로라 계정에 올리지 않아요.
- 옛 버전 탭이 새 버전 기록을 받으면 덮어쓰지 않고 새로고침하라고 알려줘요.
- 캐릭터 외형 그림은 저장하지 않고, 불러올 때 외형 주소로 다시 만들어서 용량을 아껴요.
- 프로필 메뉴의 **계정 삭제**를 누르면 계정과 저장된 기록이 데이터베이스에서 모두 지워져요.

## API 주소

`/api/character`, `/api/character/basic`, `/api/scheduler`는 구글 로그인이 필요해요. 남발 방지로 계정마다 1분 60번 · 하루 3000번, 접속 주소(IP)마다 1분 120번까지예요. 외형 그림(`/api/look`)은 따로 접속 주소마다 1분 600번이에요. 로그인은 접속 주소마다 1분 20번, 기록 저장은 계정마다 1분 40번이에요. 넘으면 `429`와 `retry-after`(초)가 와요. 하루 한도는 한국 시간 자정에 바뀌어요.

물욕 가격 공개 조회는 접속 주소마다 1분에 전체 `/api/loot-prices` 60번 · 판 번호 `/api/loot-ver` 120번까지예요(과하게 부르는 것만 막는 안전장치라 서버 메모리에서만 세요).

숫자는 대시보드 변수 `RATE_USER_MIN` · `RATE_USER_DAY` · `RATE_IP_MIN` · `RATE_LOOK_MIN` · `RATE_LOOT_MIN` · `RATE_LOOT_VER_MIN`으로 바꿀 수 있어요. `wrangler.toml`의 `keep_vars = true` 덕분에 대시보드에서 넣은 값은 배포해도 남아요. `RATE_SITE_DAY`를 넣으면 사이트 전체 하루 조회 수도 그 수에서 멈춰요 (넥슨 개발 키 동안 450 추천, 서비스 키로 바꾸면 지우기).

| 주소 | 하는 일 |
|---|---|
| `GET /api/health` | 서버 확인 |
| `GET /api/character?name=캐릭터명` | 이름 → ocid → 월드·레벨·직업·외형 이미지 |
| `GET /api/character/basic?ocid=…` | 저장해 둔 ocid로 다시 불러오기 (새로고침) |
| `GET /api/scheduler?ocid=…` | 인게임 스케줄러(보스 완료 여부). 나중에 자동 클리어 체크용 |
| `GET /api/config` | 로그인 사용 가능 여부 |
| `POST /api/auth/google` · `POST /api/auth/logout` | 구글 로그인 · 로그아웃 |
| `GET /api/me` | 지금 로그인한 계정 |
| `GET /api/state` · `PUT /api/state` | 내 기록 불러오기 · 저장하기 (겹치면 409) |
| `DELETE /api/account` | 계정과 기록 삭제 |
| `GET /api/look?u=…` | 넥슨 외형 이미지 전달 (넥슨 외형 이미지 주소만, 이미지 응답만) |

응답 예시 (`/api/character`):

```json
{ "ocid": "…", "name": "렌코덱", "world": "베라", "level": 290, "job": "렌",
  "image": "https://open.api.nexon.com/static/maplestory/character/look/…",
  "guild": null, "date": null }
```

오류는 넥슨과 같은 모양으로 돌려줘요: `{ "error": { "name": "OPENAPI00004", "message": "…" } }`

## 알아둘 것

- **호출 한도:** 개발 단계 키는 초당 5건, 하루 1,000건이에요. 서비스 단계 키는 초당 500건, 하루 2,000만 건이에요.
  서비스 키는 서비스 주소를 적고 애플리케이션을 새로 등록해서 받아요 (키가 바뀌면 `NEXON_API_KEY`도 바꾸기).
- **다른 사이트에서 부르기:** `ALLOWED_ORIGINS`는 넥슨 조회 응답에 붙는 CORS 허용 주소일 뿐, 요청 자체를 막지는 않아요.
  캐릭터 조회는 구글 로그인 + 남발 방지로 지켜요.
- **관리 화면(`/admin`):** 비밀번호가 맞으면 30분짜리 관리 쿠키를 줘요. 비밀번호는 브라우저에 남기지 않아요.
  비밀번호를 한 주소에서 15분에 5번, 사이트 전체로 1시간에 30번 넘게 틀리면 잠깐 막혀요.
  탭은 물욕 가격 · 기본 물욕템(보스·난이도마다 기록 창에 처음부터 켜 둘 템) · 등급 기준(브론즈~블랙 금액) 세 개예요.
  저장하면 판 번호가 바뀌고, 열어 둔 사이트는 1분마다 판 번호만 확인해서 1~2분 안에 바뀌어요 (아무것도 안 누른 채 3번 지나면 쉬었다가 다시 누르면 이어서).
- **캐시:** 같은 이름은 하루, 기본 정보는 10분 동안 기억해서 호출을 아껴요.
  `workers.dev` 주소에서는 캐시가 저장되지 않고 내 도메인을 연결했을 때만 동작해요. 캐시가 안 돼도 조회는 정상이에요.
- **데이터 갱신:** 넥슨 정책상 API로 받은 데이터는 30일 안에 다시 갱신해야 해요. 캐릭터마다 불러온 날짜를 저장해 두고, 30일이 지난 캐릭터는 접속할 때 한 명씩 조용히 다시 불러와요(한 번 접속에 10명까지).
- **출처 표시:** 사이트에 `Data based on NEXON Open API` 문구를 꼭 표시해야 해요 (화면 왼쪽 아래에 넣어 둠).

## 저작권 · 출처

메푸리는 넥슨과 관련 없는 비공식 팬 사이트예요. 돈을 받지 않는 무료 도구로 운영해요.

- **게임 데이터:** Data based on NEXON Open API. 화면 왼쪽 아래에 표시해요.
- **게임 그림:** MapleStory © NEXON Korea Corp. 보스·아이템 아이콘, 직업 일러스트, 캐릭터 이미지의 권리는 모두 넥슨에 있어요.
  - 직업 일러스트는 넥슨 메이플스토리 공식 직업 일러스트예요. (파일은 [MapleStory Wiki](https://maplestorywiki.net)에서 받아 줄여서 넣음)
  - 넥슨 [게임 IP 사용 가이드](https://member.nexon.com/policy/gameipguide.aspx)에 따라 출처(넥슨 · 메이플스토리)와 비공식이라는 문구를 화면에 표시해요.
- **글꼴**
  - Noto Sans KR — SIL Open Font License 1.1, Google Fonts에서 불러와요.
  - Pretendard — SIL Open Font License 1.1, Copyright (c) 2021 Kil Hyung-jin. 숫자·억·만 글자만 잘라서 페이지에 넣었어요. 예약 글꼴 이름 조항에 따라 잘라낸 글꼴은 `MepuriNum`이라는 이름으로 써요. 라이선스 원문: `licenses/Pretendard-OFL.txt`
- 결정석 가격, 보스·아이템 이름 같은 게임 수치는 사실 정보로 직접 정리했어요.
- 넥슨 요청이 있으면 해당 그림이나 기능은 바로 내려요.
