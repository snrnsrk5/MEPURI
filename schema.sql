-- 메푸리 D1 표 구조 (참고용 — Worker가 처음 로그인할 때 자동으로 만들어요)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,   -- 구글 계정 고유번호
  email TEXT, name TEXT, picture TEXT,
  created_at TEXT, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,       -- 로그인 쿠키 값의 해시 (원래 값은 저장 안 함)
  user_id INTEGER NOT NULL,
  created_at TEXT, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,                -- 사이트 기록 전체 (JSON)
  rev INTEGER NOT NULL DEFAULT 0,    -- 저장 번호 (다른 기기와 겹침 확인용)
  updated_at TEXT
);

-- 물욕 시세 (억 메소). 날짜마다 템 시세를 통째로 저장
CREATE TABLE IF NOT EXISTS loot_prices (
  d TEXT NOT NULL,                   -- 'YYYY.MM.DD'
  item TEXT NOT NULL,
  price REAL NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (d, item)
);
-- 관리 화면에서 정한 사이트 설정 (물욕 등급 기준 'tiers', 기본 물욕템 'lootOn'). 값은 JSON
CREATE TABLE IF NOT EXISTS site_conf (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT
);
-- 관리 비밀번호를 틀린 횟수 (주소마다, 5번 틀리면 15분 막힘)
CREATE TABLE IF NOT EXISTS admin_fail (
  ip TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0   -- 막힌 게 풀리는 시각 (밀리초)
);

-- 캐릭터 조회 남발 방지 (계정·접속 주소마다 시간 칸별 횟수)
CREATE TABLE IF NOT EXISTS api_rate (
  k TEXT PRIMARY KEY,                -- 'u:계정번호:60:칸번호' 같은 모양
  n INTEGER NOT NULL,
  reset INTEGER NOT NULL             -- 이 칸이 끝나는 시각 (초)
);

-- 이름으로 찾은 결과를 12시간 기억 (손님 조회가 같은 이름이면 넥슨을 다시 안 부름). 누가 찾았는지는 저장 안 함
CREATE TABLE IF NOT EXISTS name_memo (
  k TEXT PRIMARY KEY,                -- 캐릭터 이름 (소문자)
  v TEXT NOT NULL,                   -- 찾은 결과 (JSON: ocid·이름·월드·레벨·직업·외형 주소)
  exp INTEGER NOT NULL               -- 이 시각(초)이 지나면 안 씀
);

-- 방문 통계 (익명). 날짜(한국 시간)마다 브라우저 하나에 한 줄. 180일 지난 날은 자동으로 지워요
CREATE TABLE IF NOT EXISTS stat_vis (
  d TEXT NOT NULL,                   -- 'YYYY.MM.DD'
  v TEXT NOT NULL,                   -- 사이트가 브라우저에 둔 무작위 번호의 해시 (원래 값·IP는 저장 안 함)
  li INTEGER NOT NULL DEFAULT 0,     -- 그날 로그인한 채로 열었나
  nw INTEGER NOT NULL DEFAULT 0,     -- 이 브라우저의 첫 방문이었나
  pv INTEGER NOT NULL DEFAULT 0,     -- 그날 화면을 연 횟수
  st INTEGER NOT NULL DEFAULT 0,     -- 그날 화면을 보고 있던 초 (하루 12시간까지)
  PRIMARY KEY (d, v)
);
