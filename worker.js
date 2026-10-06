/**
 * 메푸리 API 서버 (Cloudflare Worker)
 * 넥슨 Open API 키를 서버에만 두고, 사이트는 캐릭터 이름만 보내서 조회한다.
 *
 * 필요한 설정 (Cloudflare 대시보드 → 이 Worker → 설정 → 변수 및 비밀)
 *   NEXON_API_KEY   (비밀, 필수)  openapi.nexon.com에서 받은 API 키
 *   ALLOWED_ORIGINS (선택)        넥슨 조회 응답에 CORS 허용 헤더를 붙일 다른 사이트 주소(쉼표로 구분). 비워두면 모두 허용.
 *                                 ※ 요청 자체를 막지는 않음 — 막는 건 구글 로그인 + 남발 방지
 *   RATE_* (선택)                 남발 방지 숫자 (아래). wrangler.toml의 keep_vars 덕분에 대시보드에서 넣은 값이 배포 뒤에도 남음
 *
 * 사이트(public 폴더)도 같이 올리면 이 Worker가 사이트와 API를 한 주소에서 같이 보여줌.
 *
 * 주소
 *   GET /api/health                    서버 확인
 *   GET /api/character?name=캐릭터명   이름 → 월드·레벨·직업·외형 이미지
 *   GET /api/character/basic?ocid=…    저장해 둔 ocid로 다시 불러오기(새로고침)
 *   GET /api/character/basic?ocid=…&date=YYYY-MM-DD   그날 기준 정보 (지난 월드 확인용)
 *   GET /api/scheduler?ocid=…          인게임 스케줄러(보스 완료 여부) 원본 그대로
 *   GET /api/look?u=외형이미지주소     넥슨 외형 이미지를 같은 주소로 전달 (사이트가 캐릭터 부분만 잘라 쓰려고)
 *
 * 구글 로그인 + 기록 저장 (D1 데이터베이스 DB, 비밀값 GOOGLE_CLIENT_ID 필요)
 *   GET    /api/config              로그인 사용 가능 여부 + 구글 클라이언트 ID (공개값)
 *   POST   /api/auth/google         구글 로그인 토큰 확인 → 로그인 쿠키 발급
 *   POST   /api/auth/logout         로그아웃
 *   GET    /api/me                  지금 로그인한 계정
 *   GET    /api/state               내 기록 불러오기  { data, rev, updatedAt }
 *   PUT    /api/state               내 기록 저장하기  { data, rev } — rev가 서버와 다르면 409 + 서버 기록
 *   DELETE /api/account             계정과 기록 모두 삭제
 *
 * 캐릭터 조회(/api/character, /api/character/basic, /api/scheduler)는 구글 로그인한 사람만 쓸 수 있음
 *   남발 방지: 계정마다 1분 RATE_USER_MIN번 · 하루 RATE_USER_DAY번, 접속 주소(IP)마다 1분 RATE_IP_MIN번 (넘으면 429)
 *   기본값 60 · 3000 · 120 — 대시보드 변수로 바꿀 수 있음. /api/look(외형 그림)은 로그인 없이 되고 IP 제한만 (따로 1분 RATE_LOOK_MIN번, 기본 600)
 *   RATE_SITE_DAY를 넣으면 사이트 전체 하루 조회도 그 수에서 멈춤 (넥슨 개발 키 동안 450 추천). 하루는 한국 시간 자정에 바뀜
 *   그 밖에 로그인은 주소마다 1분 20번, 기록 저장은 계정마다 1분 40번
 *
 * 물욕 시세 (D1 데이터베이스 DB, 비밀값 ADMIN_PASSWORD 필요 — 없으면 시세 고치기는 꺼짐)
 *   GET  /api/loot-prices            날짜별 시세 전체  { hist:[{ d:'2026.10.03', p:{ 템이름: 억 } }] } (누구나)
 *                                    관리 화면은 '한 벌 시세'(d=2000.01.01)만 저장하고, 저장할 때 예전 날짜 행은 지움
 *   POST /api/admin/login            { password } 비밀번호 확인
 *   POST /api/admin/prices           { d, p } 그 날짜 시세를 통째로 저장 (빈 목록은 거절)
 *   POST /api/admin/delete           { d } 그 날짜 시세 지우기 (관리 쿠키 또는 password 필요)
 *   POST /api/admin/logout           관리 쿠키 지우기
 *   관리 화면: /admin  (비밀번호를 5번 틀리면 그 주소에서 15분, 사이트 전체로 1시간에 30번 넘게 틀리면 막힘.
 *                      맞으면 30분짜리 관리 쿠키를 줘서 그동안은 비밀번호 없이 저장 — 비밀번호는 브라우저에 안 남김)
 */

const NEXON = 'https://open.api.nexon.com/maplestory/v1/';

// 같은 요청을 잠깐 기억해서 호출 한도를 아낌 (초 단위)
// ※ Cache API는 workers.dev 주소에선 저장이 안 되고, 내 도메인을 연결하면 동작함. 안 돼도 조회는 정상.
const TTL = { id: 60 * 60 * 24, basic: 60 * 10, scheduler: 60 * 5 };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);

    // /api/ 가 아닌 주소는 사이트 파일(public 폴더)로 넘김
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(req);
      if (url.pathname === '/') return json({ ok: true, service: 'mepuri-api' }, 200, cors);
      return fail(404, 'NOT_FOUND', '없는 주소예요', cors);
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/api/health') return json({ ok: true, service: 'mepuri-api' }, 200, cors);

    // 로그인·기록 저장 (같은 사이트에서만 부름 — 쿠키를 쓰므로 CORS 헤더는 안 붙임)
    if (url.pathname === '/api/config' || url.pathname.startsWith('/api/auth/') || url.pathname === '/api/me' || url.pathname === '/api/state' || url.pathname === '/api/account') {
      try { return await account(req, env, url); }
      catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.code, e.message, {});
        return fail(500, 'SERVER', '서버 오류예요. 잠시 후 다시 시도해 주세요', {});
      }
    }
    // 물욕 시세: 읽기는 누구나, 고치기는 관리 비밀번호
    if (url.pathname === '/api/loot-prices' || url.pathname.startsWith('/api/admin/')) {
      try { return await lootPrices(req, env, url, cors); }
      catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.code, e.message, {});
        return fail(500, 'SERVER', '서버 오류예요. 잠시 후 다시 시도해 주세요', {});
      }
    }
    if (req.method !== 'GET') return fail(405, 'METHOD', 'GET 요청만 받아요', cors);

    // 넥슨 조회: 로그인 확인 + 남발 방지 (외형 그림은 IP 제한만)
    if (url.pathname === '/api/look' || NEXON_PATHS.includes(url.pathname)) {
      try { await guardNexon(req, env, url.pathname !== '/api/look'); }
      catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.code, e.message, e.retry ? { ...cors, 'retry-after': String(e.retry) } : cors);
        return fail(500, 'SERVER', '서버 오류예요. 잠시 후 다시 시도해 주세요', cors);
      }
    }

    // 외형 이미지는 키가 필요 없음. 넥슨 외형 이미지 주소만 받아서 그대로 전달
    if (url.pathname === '/api/look') {
      // 주소를 정리(../ 풀기)한 뒤 넥슨 외형 이미지 경로인지 확인하고, 이미지 응답만 통과 (V2)
      const okLook = (u, any) => u.protocol === 'https:' && u.host === 'open.api.nexon.com' && !u.username && !u.password
        && u.pathname.startsWith(any ? '/static/maplestory/' : '/static/maplestory/character/look/');
      let lu; try { lu = new URL(url.searchParams.get('u') || ''); } catch { return fail(400, 'BAD_URL', '외형 이미지 주소가 아니에요', cors); }
      if (!okLook(lu)) return fail(400, 'BAD_URL', '외형 이미지 주소가 아니에요', cors);
      // 브라우저가 아닌 요청이라 넥슨이 거절하거나 주소를 옮겨 줄(리다이렉트) 때가 있어서:
      // 누가 보내는지 밝히는 머리글을 붙이고, 넥슨 이미지 주소 안에서만 3번까지 따라감 (V12)
      let r, cur = lu;
      const sig = AbortSignal.timeout(8000); // 그림은 8초 안에 못 받으면 포기 (사이트는 원본 그림으로 먼저 보여 줌)
      try {
        for (let i = 0; ; i++) {
          r = await fetch(cur.toString(), { redirect: 'manual', signal: sig, headers: { 'user-agent': 'Mozilla/5.0 (compatible; MEPURI/1.0; +https://github.com/snrnsrk5/MEPURI)', accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5' } });
          if (r.status < 300 || r.status >= 400 || i >= 3) break;
          let nx; try { nx = new URL(r.headers.get('location') || '', cur); } catch { break; }
          if (!okLook(nx, true)) break;
          cur = nx;
        }
      } catch (e) { return e && e.name === 'TimeoutError' ? fail(504, 'LOOK', '외형 이미지를 불러오지 못했어요 (넥슨 응답 늦음)', cors) : fail(502, 'LOOK', '외형 이미지를 불러오지 못했어요 (넥슨 연결 실패)', cors); }
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\//.test(ct)) return fail(r.status >= 400 ? r.status : 502, 'LOOK', `외형 이미지를 불러오지 못했어요 (넥슨 ${r.status})`, cors);
      return new Response(r.body, {
        status: 200,
        headers: { ...cors, 'content-type': ct, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' },
      });
    }
    if (!env.NEXON_API_KEY) return fail(500, 'NO_KEY', '서버에 NEXON_API_KEY가 설정되지 않았어요', cors);

    try {
      if (url.pathname === '/api/character') {
        const name = (url.searchParams.get('name') || '').trim();
        if (!name || name.length > 12) return fail(400, 'OPENAPI00004', '캐릭터 이름을 확인해 주세요', cors);
        const { ocid } = await nexon(env, ctx, 'id', { character_name: name }, TTL.id);
        const basic = await nexon(env, ctx, 'character/basic', { ocid }, TTL.basic);
        return json(slim(ocid, basic), 200, cors);
      }

      if (url.pathname === '/api/character/basic') {
        const ocid = url.searchParams.get('ocid');
        if (!ocid) return fail(400, 'OPENAPI00003', 'ocid가 필요해요', cors);
        // date=YYYY-MM-DD 를 붙이면 그날 기준 정보 (예: 챌린저스 월드에 있던 때의 월드 확인)
        const date = url.searchParams.get('date') || '';
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'OPENAPI00004', '날짜는 YYYY-MM-DD 형식이에요', cors);
        const basic = await nexon(env, ctx, 'character/basic', date ? { ocid, date } : { ocid }, date ? TTL.id : TTL.basic);
        return json(slim(ocid, basic), 200, cors);
      }

      if (url.pathname === '/api/scheduler') {
        const ocid = url.searchParams.get('ocid');
        if (!ocid) return fail(400, 'OPENAPI00003', 'ocid가 필요해요', cors);
        const data = await nexon(env, ctx, 'scheduler/character-state', { ocid }, TTL.scheduler);
        return json(data, 200, cors);
      }

      return fail(404, 'NOT_FOUND', '없는 주소예요', cors);
    } catch (e) {
      if (e instanceof NexonError) return fail(e.status, e.code, e.message, cors);
      return fail(500, 'SERVER', '서버 오류예요. 잠시 후 다시 시도해 주세요', cors);
    }
  },
};

class NexonError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 넥슨 API 호출 (키는 헤더로만 보내고, 캐시 주소에는 넣지 않음)
async function nexon(env, ctx, path, params, ttl) {
  const u = new URL(NEXON + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const cache = caches.default;
  const cacheKey = new Request(u.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  // 넥슨이 오래 답이 없으면 15초에 끊고 알려 줌 (조회 창이 끝없이 도는 걸 막음, V12)
  let res;
  try { res = await fetch(u, { headers: { 'x-nxopen-api-key': env.NEXON_API_KEY }, signal: AbortSignal.timeout(15000) }); }
  catch (e) {
    if (e && e.name === 'TimeoutError') throw new NexonError(504, 'NEXON_SLOW', '넥슨 응답이 늦어요. 잠시 후 다시 시도해 주세요');
    throw new NexonError(502, 'NEXON_NET', '넥슨에 연결하지 못했어요. 잠시 후 다시 시도해 주세요');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body.error || {};
    throw new NexonError(res.status, err.name || 'NEXON', err.message || '넥슨 API 오류');
  }
  // 빈 응답(아직 데이터 준비 전)은 기억하지 않음
  if (ttl && body && Object.keys(body).length) {
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
    })));
  }
  return body;
}

// 사이트에 필요한 값만 추려서 돌려줌
function slim(ocid, b) {
  if (!b || !b.character_name) throw new NexonError(404, 'NO_DATA', '아직 이 캐릭터 정보가 없어요. 잠시 후 다시 시도해 주세요');
  return {
    ocid,
    name: b.character_name,
    world: b.world_name,
    level: b.character_level,
    job: b.character_class,
    image: b.character_image || null, // 외형(코디) 이미지 주소, 키 없이 <img>로 바로 쓸 수 있음
    guild: b.character_guild_name || null,
    date: b.date || null,
  };
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = !list.length ? '*' : list.includes(origin) ? origin : list[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function fail(status, name, message, headers) {
  return json({ error: { name, message } }, status, headers);
}

/* ================= 구글 로그인 + 기록 저장 ================= */

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SESSION_COOKIE = 'mp_sess';
const SESSION_DAYS = 30;
const MAX_STATE = 900 * 1024; // 기록 한 덩어리 최대 크기 (D1 한 칸 제한보다 넉넉히 작게)

async function account(req, env, url) {
  const p = url.pathname, m = req.method;
  const ready = !!(env.DB && env.GOOGLE_CLIENT_ID);

  if (p === '/api/config' && m === 'GET') {
    return json({ auth: ready, googleClientId: ready ? env.GOOGLE_CLIENT_ID : null }, 200, noStore());
  }
  if (!ready) throw new HttpError(503, 'NO_AUTH', '로그인 기능이 아직 설정되지 않았어요');

  // 다른 사이트에서 쿠키를 이용해 몰래 보내는 요청 막기: 바꾸는 요청은 같은 주소 + 전용 헤더만
  if (m !== 'GET') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'ORIGIN', '다른 사이트에서는 요청할 수 없어요');
    if (req.headers.get('x-mepuri') !== '1') throw new HttpError(403, 'HEADER', '잘못된 요청이에요');
  }
  await ensureSchema(env.DB);

  if (p === '/api/auth/google' && m === 'POST') {
    await ensureRateSchema(env.DB);
    await hit(env.DB, 'login:' + (req.headers.get('CF-Connecting-IP') || 'unknown'), 60, 20, '로그인을 너무 자주 했어요'); // (V7)
    const body = await readJson(req, 16 * 1024);
    const claims = await verifyGoogleIdToken(String(body.credential || ''), env.GOOGLE_CLIENT_ID);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (google_sub, email, name, picture, created_at, last_login) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(google_sub) DO UPDATE SET email = ?2, name = ?3, picture = ?4, last_login = ?5`
    ).bind(claims.sub, claims.email || null, claims.name || null, claims.picture || null, now).run();
    const user = await env.DB.prepare('SELECT id, email, name, picture FROM users WHERE google_sub = ?1').bind(claims.sub).first();
    const token = randomToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now), // 만료된 로그인 정리
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(await sha256(token), user.id, now, exp),
    ]);
    return json({ user: publicUser(user) }, 200, { ...noStore(), 'set-cookie': cookie(token, SESSION_DAYS * 86400) });
  }

  const me = await sessionUser(req, env);

  if (p === '/api/auth/logout' && m === 'POST') {
    const t = readCookie(req, SESSION_COOKIE);
    if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(t)).run();
    return json({ ok: true }, 200, { ...noStore(), 'set-cookie': cookie('', 0) });
  }
  if (p === '/api/me' && m === 'GET') return json({ user: me ? publicUser(me) : null }, 200, noStore());

  if (!me) throw new HttpError(401, 'LOGIN', '로그인이 필요해요');

  if (p === '/api/state' && m === 'GET') {
    const row = await env.DB.prepare('SELECT data, rev, updated_at FROM user_state WHERE user_id = ?1').bind(me.id).first();
    return json(row ? { data: JSON.parse(row.data), rev: row.rev, updatedAt: row.updated_at } : { data: null, rev: 0, updatedAt: null }, 200, noStore());
  }
  if (p === '/api/state' && m === 'PUT') {
    await ensureRateSchema(env.DB);
    await hit(env.DB, 'save:' + me.id, 60, 40, '저장을 너무 자주 했어요'); // 정상 사용은 1분에 몇 번 (V7)
    const text = await req.text();
    if (text.length > MAX_STATE) throw new HttpError(413, 'TOO_BIG', '기록이 너무 커서 저장하지 못했어요');
    let body; try { body = JSON.parse(text); } catch { throw new HttpError(400, 'JSON', '잘못된 요청이에요'); }
    if (!body || typeof body.data !== 'object' || body.data === null) throw new HttpError(400, 'DATA', '저장할 기록이 없어요');
    const base = Number.isInteger(body.rev) ? body.rev : -1;
    const data = JSON.stringify(body.data), now = new Date().toISOString();
    // rev가 같을 때만 저장 (다른 기기에서 먼저 저장했으면 덮어쓰지 않음)
    const r = base === 0
      ? await env.DB.prepare('INSERT INTO user_state (user_id, data, rev, updated_at) SELECT ?1, ?2, 1, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1) ON CONFLICT(user_id) DO NOTHING').bind(me.id, data, now).run() // 계정을 막 지운 뒤 들어온 저장은 안 남김 (V8)
      : await env.DB.prepare('UPDATE user_state SET data = ?2, rev = rev + 1, updated_at = ?3 WHERE user_id = ?1 AND rev = ?4').bind(me.id, data, now, base).run();
    if (!r.meta || !r.meta.changes) {
      const row = await env.DB.prepare('SELECT data, rev, updated_at FROM user_state WHERE user_id = ?1').bind(me.id).first();
      return json({ error: { name: 'CONFLICT', message: '다른 기기에서 먼저 저장한 기록이 있어요' }, data: row ? JSON.parse(row.data) : null, rev: row ? row.rev : 0, updatedAt: row ? row.updated_at : null }, 409, noStore());
    }
    return json({ rev: base + 1, updatedAt: now }, 200, noStore());
  }
  if (p === '/api/account' && m === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM user_state WHERE user_id = ?1').bind(me.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(me.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(me.id),
    ]);
    return json({ ok: true }, 200, { ...noStore(), 'set-cookie': cookie('', 0) });
  }
  throw new HttpError(404, 'NOT_FOUND', '없는 주소예요');
}

// ── 캐릭터 조회 지키기: 구글 로그인 + 남발 방지 ──
const NEXON_PATHS = ['/api/character', '/api/character/basic', '/api/scheduler'];
async function guardNexon(req, env, needLogin) {
  if (!env.DB) { if (needLogin) throw new HttpError(503, 'NO_AUTH', '로그인 기능이 아직 설정되지 않아서 조회할 수 없어요'); return; }
  await ensureRateSchema(env.DB);
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const lim = (k, d) => { const n = parseInt(env[k], 10); return n > 0 ? n : d; };
  // 외형 그림(/api/look)은 따로 셈: 캐릭터가 많아도 그림 때문에 캐릭터 조회가 막히지 않게
  if (!needLogin) { await hit(env.DB, 'ipl:' + ip, 60, lim('RATE_LOOK_MIN', 600), '외형 그림 요청이 너무 많아요'); return; }
  await hit(env.DB, 'ip:' + ip, 60, lim('RATE_IP_MIN', 120), '이 접속 주소에서 요청이 너무 많아요');
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'NO_AUTH', '로그인 기능이 아직 설정되지 않아서 조회할 수 없어요');
  await ensureSchema(env.DB);
  const me = await sessionUser(req, env);
  if (!me) throw new HttpError(401, 'LOGIN', '구글 계정으로 로그인해야 캐릭터를 조회할 수 있어요');
  await hit(env.DB, 'u:' + me.id, 60, lim('RATE_USER_MIN', 60), '조회를 너무 자주 했어요');
  await hit(env.DB, 'ud:' + me.id, 86400, lim('RATE_USER_DAY', 3000), '오늘 조회 횟수를 다 썼어요');
  // 사이트 전체 하루 한도 (넣었을 때만): 넥슨 개발 키(하루 1,000건) 동안 한 사람이 다 써 버리는 걸 막음 (V3)
  const site = parseInt(env.RATE_SITE_DAY, 10);
  if (site > 0) await hit(env.DB, 'site', 86400, site, '오늘 사이트 전체 조회 한도를 다 썼어요');
}
// 고정 시간 칸(초)마다 횟수 세기. 넘으면 429 + 몇 초 뒤 다시
async function hit(db, key, sec, max, msg) {
  // 하루 칸은 한국 시간 자정에 바뀜 (예전엔 UTC 자정 = 오전 9시) (V11)
  const off = sec >= 86400 ? 9 * 3600 : 0;
  const now = Math.floor(Date.now() / 1000), win = Math.floor((now + off) / sec), k = `${key}:${sec}:${win}`, reset = (win + 1) * sec - off;
  // 이미 한도를 넘은 칸이면 DB에 쓰지 않고 바로 거절 (무료 쓰기 한도 아끼기, V7)
  const cur = await db.prepare('SELECT n FROM api_rate WHERE k = ?1').bind(k).first();
  if (cur && cur.n >= max) { const wait = reset - now, e = new HttpError(429, 'RATE', `${msg}. ${wait >= 3600 ? Math.ceil(wait / 3600) + '시간' : wait >= 60 ? Math.ceil(wait / 60) + '분' : wait + '초'} 뒤에 다시 시도해 주세요`); e.retry = wait; throw e; }
  const row = await db.prepare('INSERT INTO api_rate (k, n, reset) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(k, reset).first();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM api_rate WHERE reset < ?1').bind(now).run(); // 지난 칸 가끔 청소
  if (row && row.n > max) {
    const wait = reset - now, e = new HttpError(429, 'RATE', `${msg}. ${wait >= 3600 ? Math.ceil(wait / 3600) + '시간' : wait >= 60 ? Math.ceil(wait / 60) + '분' : wait + '초'} 뒤에 다시 시도해 주세요`);
    e.retry = wait; throw e;
  }
}
let rateSchemaReady = false;
async function ensureRateSchema(db) {
  if (rateSchemaReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS api_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)').run();
  rateSchemaReady = true;
}

// ── 물욕 시세 ──
// 시세는 억 메소 단위 숫자. 날짜는 'YYYY.MM.DD' (사이트와 같은 모양)
const PRICE_MAX_ITEMS = 300, FAIL_LIMIT = 5, FAIL_LOCK_MIN = 15;
async function lootPrices(req, env, url, cors) {
  const p = url.pathname, m = req.method;
  if (!env.DB) throw new HttpError(503, 'NO_DB', '데이터베이스가 아직 설정되지 않았어요');
  await ensurePriceSchema(env.DB);

  if (p === '/api/loot-prices' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT d, item, price FROM loot_prices ORDER BY d, item').all();
    const by = new Map();
    for (const r of results || []) { if (!by.has(r.d)) by.set(r.d, {}); by.get(r.d)[r.item] = r.price; }
    return json({ hist: [...by].map(([d, pr]) => ({ d, p: pr })) }, 200, { ...cors, 'cache-control': 'public, max-age=60' });
  }
  if (m !== 'POST') throw new HttpError(405, 'METHOD', 'POST 요청만 받아요');
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_OFF', '관리 비밀번호가 아직 설정되지 않았어요');
  // 다른 사이트 페이지에서 몰래 보내는 요청 막기 (Origin이 붙어 오면 같은 주소여야 함)
  const origin = req.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'ORIGIN', '다른 사이트에서는 요청할 수 없어요');

  const body = await readJson(req, 64 * 1024);
  if (p === '/api/admin/logout') return json({ ok: true }, 200, { ...noStore(), 'set-cookie': adminCookie('', 0) });
  const viaCookie = await adminCookieOk(req, env);
  if (!viaCookie && !body.password) throw new HttpError(401, 'LOGIN', '다시 로그인해 주세요 (관리 쿠키가 없거나 30분이 지났어요)'); // 틀린 횟수에 안 셈
  if (!viaCookie) await checkAdmin(req, env, typeof body.password === 'string' ? body.password : '');
  // 비밀번호로 들어오면 30분짜리 관리 쿠키를 줌 (비밀번호는 브라우저에 남기지 않음)
  const keep = viaCookie ? {} : { 'set-cookie': adminCookie(await adminToken(env, Date.now() + ADMIN_COOKIE_MIN * 60000), ADMIN_COOKIE_MIN * 60) };

  if (p === '/api/admin/login') return json({ ok: true, min: ADMIN_COOKIE_MIN }, 200, { ...noStore(), ...keep });
  const d = String(body.d || '');
  if (!validDay(d)) throw new HttpError(400, 'DATE', '날짜는 2026.10.03 모양으로 적어 주세요');

  if (p === '/api/admin/prices') {
    const src = body.p && typeof body.p === 'object' && !Array.isArray(body.p) ? body.p : null;
    if (!src) throw new HttpError(400, 'PRICES', '저장할 시세가 없어요');
    const rows = [], seen = new Set();
    for (const [item, v] of Object.entries(src)) {
      const name = String(item).replace(/\s+/g, ' ').trim(); // 공백만 다른 같은 이름은 하나로 (V5)
      if (!name || name.length > 60) throw new HttpError(400, 'ITEM', '템 이름이 이상해요: ' + name.slice(0, 20));
      if (v === null || v === '') continue; // 빈 칸은 저장 안 함
      // 숫자만 받기: 0x10·true·공백 같은 건 거절 (V6)
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new HttpError(400, 'PRICE', `${name} 시세가 숫자가 아니에요 (억 단위 숫자)`);
      if (n < 0) throw new HttpError(400, 'PRICE', `${name} 시세가 0보다 작아요`);
      if (n > 100000) throw new HttpError(400, 'PRICE', `${name} 시세가 너무 커요 (억 단위, 10만 억까지)`);
      if (seen.has(name)) throw new HttpError(400, 'ITEM', `${name}이(가) 두 번 들어 있어요`);
      seen.add(name); rows.push([name, Math.round(n * 1000) / 1000]);
    }
    if (!rows.length) throw new HttpError(400, 'EMPTY', '저장할 시세가 없어요. 모두 지우려면 "저장한 값 지우기"를 써 주세요'); // 빈 목록으로 통째로 지워지는 것 막기 (V6)
    if (rows.length > PRICE_MAX_ITEMS) throw new HttpError(400, 'TOO_MANY', '템이 너무 많아요');
    const now = new Date().toISOString();
    await env.DB.batch([
      // 한 벌 시세를 저장하면 예전에 쌓인 날짜 행도 같이 지움 — 날짜 행이 남아 있으면 그 값이 이겨서 저장해도 안 바뀌던 문제 (V4)
      d === ALL_DAY ? env.DB.prepare('DELETE FROM loot_prices') : env.DB.prepare('DELETE FROM loot_prices WHERE d = ?1').bind(d),
      ...rows.map(([name, n]) => env.DB.prepare('INSERT INTO loot_prices (d, item, price, updated_at) VALUES (?1, ?2, ?3, ?4)').bind(d, name, n, now)),
    ]);
    return json({ ok: true, d, count: rows.length }, 200, { ...noStore(), ...keep });
  }
  if (p === '/api/admin/delete') {
    await (d === ALL_DAY ? env.DB.prepare('DELETE FROM loot_prices') : env.DB.prepare('DELETE FROM loot_prices WHERE d = ?1').bind(d)).run();
    return json({ ok: true, d }, 200, { ...noStore(), ...keep });
  }
  throw new HttpError(404, 'NOT_FOUND', '없는 주소예요');
}

// 날짜 칸: 관리 화면의 '한 벌 시세'(2000.01.01) 또는 실제 있는 날짜만 (2026.02.31 같은 건 거절, V6)
const ALL_DAY = '2000.01.01'; // 관리 화면이 저장하는 '모든 날짜에 쓰는 한 벌 시세' 칸
function validDay(d) {
  if (d === ALL_DAY) return true;
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(d); if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
// 비밀번호 확인 + 많이 틀리면 잠깐 막기
//  · 비밀번호를 비교하기 전에 시도 횟수부터 올림 → 한꺼번에 여러 개를 보내도 하나씩 셈 (V1)
//  · 주소(IP)마다 15분에 5번, 사이트 전체로 1시간에 30번 넘게 틀리면 막힘 (주소를 바꿔 가며 시도하는 것도 막음)
const FAIL_ALL = 30, FAIL_ALL_MIN = 60;
async function checkAdmin(req, env, password) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown', now = Date.now();
  const bump = (k, min) => env.DB.prepare(
    `INSERT INTO admin_fail (ip, n, until) VALUES (?1, 1, ?2)
     ON CONFLICT(ip) DO UPDATE SET n = CASE WHEN until <= ?3 THEN 1 ELSE n + 1 END, until = CASE WHEN until <= ?3 THEN ?2 ELSE until END
     RETURNING n, until`).bind(k, now + min * 60000, now).first();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM admin_fail WHERE until < ?1 AND ip != '*'").bind(now - 864e5).run(); // 하루 지난 실패 기록 정리 (V8)
  const me = await bump(ip, FAIL_LOCK_MIN);
  if (me.n > FAIL_LIMIT) throw new HttpError(429, 'LOCKED', `비밀번호를 여러 번 틀려서 ${Math.ceil((me.until - now) / 60000)}분 동안 막혔어요`);
  const all = await bump('*', FAIL_ALL_MIN);
  if (all.n > FAIL_ALL) throw new HttpError(429, 'LOCKED', `관리 로그인 시도가 너무 많아서 ${Math.ceil((all.until - now) / 60000)}분 동안 막혔어요`);
  const ok = password.length > 0 && password.length <= 200 && (await sha256(password)) === (await sha256(String(env.ADMIN_PASSWORD)));
  if (ok) { // 맞으면 이번 시도는 빼 줌
    await env.DB.batch([env.DB.prepare('DELETE FROM admin_fail WHERE ip = ?1').bind(ip), env.DB.prepare("UPDATE admin_fail SET n = MAX(n - 1, 0) WHERE ip = '*'")]);
    return;
  }
  const left = FAIL_LIMIT - me.n;
  throw new HttpError(401, 'PASSWORD', left <= 0 ? `비밀번호를 ${FAIL_LIMIT}번 틀려서 ${FAIL_LOCK_MIN}분 동안 막혔어요` : `비밀번호가 달라요 (${me.n}/${FAIL_LIMIT})`);
}
// 30분 관리 쿠키: 만료 시각 + 서명(관리 비밀번호로 만든 HMAC). 비밀번호를 바꾸면 예전 쿠키는 저절로 무효 (V9)
const ADMIN_COOKIE = 'mepuri_admin', ADMIN_COOKIE_MIN = 30;
const adminCookie = (v, maxAge) => `${ADMIN_COOKIE}=${v}; Path=/api/admin/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
async function adminSig(env, exp) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('mepuri-admin|' + String(env.ADMIN_PASSWORD)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(exp)))));
}
async function adminToken(env, exp) { return exp + '.' + await adminSig(env, exp); }
async function adminCookieOk(req, env) {
  const v = readCookie(req, ADMIN_COOKIE); if (!v) return false;
  const [exp, sig] = v.split('.'); const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() || e > Date.now() + ADMIN_COOKIE_MIN * 60000 + 60000 || !sig) return false;
  return sig === await adminSig(env, e);
}

let priceSchemaReady = false;
async function ensurePriceSchema(db) {
  if (priceSchemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS loot_prices (
      d TEXT NOT NULL, item TEXT NOT NULL, price REAL NOT NULL, updated_at TEXT, PRIMARY KEY (d, item))`),
    db.prepare('CREATE TABLE IF NOT EXISTS admin_fail (ip TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0)'),
  ]);
  priceSchemaReady = true;
}

// 표가 없으면 만들기 (처음 한 번만 실제로 실행됨)
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, google_sub TEXT NOT NULL UNIQUE,
      email TEXT, name TEXT, picture TEXT, created_at TEXT, last_login TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT, expires_at TEXT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`),
  ]);
  schemaReady = true;
}

async function sessionUser(req, env) {
  const t = readCookie(req, SESSION_COOKIE);
  if (!t) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(await sha256(t), new Date().toISOString()).first();
}

const publicUser = u => ({ name: u.name || '', email: u.email || '', picture: u.picture || '' });
const noStore = () => ({ 'cache-control': 'no-store' });
const cookie = (v, maxAge) => `${SESSION_COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function readCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function readJson(req, max) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'TOO_BIG', '요청이 너무 커요');
  let o; try { o = JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'JSON', '잘못된 요청이에요'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, 'JSON', '잘못된 요청이에요'); // null·숫자·배열 막기 (V5)
  return o;
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return b64url(b);
}
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(d));
}
function b64url(bytes) {
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, ch => ch.charCodeAt(0));
}

// 구글 로그인 토큰(JWT) 확인: 구글 서명 + 우리 앱용 + 만료 안 됨
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
let certCache = { at: 0, keys: [] };
async function googleKeys(force) {
  if (!force && certCache.keys.length && Date.now() - certCache.at < 60 * 60 * 1000) return certCache.keys;
  const r = await fetch(GOOGLE_CERTS);
  if (!r.ok) throw new HttpError(502, 'GOOGLE', '구글 서버에 연결하지 못했어요');
  certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certCache.keys;
}
export async function verifyGoogleIdToken(token, clientId) {
  const bad = () => new HttpError(401, 'TOKEN', '구글 로그인 확인에 실패했어요. 다시 시도해 주세요');
  const parts = token.split('.');
  if (parts.length !== 3) throw bad();
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  } catch { throw bad(); }
  if (header.alg !== 'RS256' || !header.kid) throw bad();
  let jwk = (await googleKeys(false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid); // 구글이 키를 바꿨을 수 있음
  if (!jwk) throw bad();
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw bad();
  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw bad();
  if (claims.aud !== clientId) throw bad();
  if (!claims.exp || claims.exp < now - 60) throw bad();
  if (!claims.sub) throw bad();
  return claims;
}
