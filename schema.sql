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
-- 관리 비밀번호를 틀린 횟수 (주소마다, 5번 틀리면 15분 막힘)
CREATE TABLE IF NOT EXISTS admin_fail (
  ip TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0   -- 막힌 게 풀리는 시각 (밀리초)
);
