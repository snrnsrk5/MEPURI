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
 *   GET    /api/config              로그인 사용 가능 여부 + 구글 클라이언트 ID (공개값) + 손님 조회 하루 횟수 guest
 *   POST   /api/auth/google         구글 로그인 토큰 확인 → 로그인 쿠키 발급
 *   POST   /api/auth/logout         로그아웃
 *   GET    /api/me                  지금 로그인한 계정
 *   GET    /api/state               내 기록 불러오기  { data, rev, updatedAt }
 *   PUT    /api/state               내 기록 저장하기  { data, rev } — rev가 서버와 다르면 409 + 서버 기록
 *   DELETE /api/account             계정과 기록 모두 삭제
 *
 * 캐릭터 조회(/api/character, /api/character/basic, /api/scheduler)는 구글 로그인한 사람만 쓸 수 있음
 *   단, 이름으로 찾기(/api/character)는 로그인 없이도 조금 됨 (손님 조회 — 처음 온 사람이 바로 써 볼 수 있게)
 *     접속 주소(IPv6는 /64, 해시로만 셈)마다 하루 RATE_GUEST_IP번(기본 3) · 손님 전체 하루 RATE_GUEST_DAY번(기본 100, 0이면 손님 조회 끔)
 *     손님 조회 1번 = 넥슨 호출 약 2번(이름→ocid→기본 정보). 사이트 전체 한도(RATE_SITE_DAY)에도 같이 셈
 *     최근에 찾은 이름은 12시간 동안 D1에 기억해 두고, 손님이 같은 이름을 찾으면 넥슨을 다시 안 부름 (workers.dev에선 Cache API가 저장을 안 해서)
 *     넘으면 429 GUEST — 사이트가 '로그인하면 계속 찾을 수 있어요' 안내를 띄움
 *   남발 방지: 계정마다 1분 RATE_USER_MIN번 · 하루 RATE_USER_DAY번(넥슨을 실제로 부를 때만 셈), 접속 주소(IP)마다 1분 RATE_IP_MIN번(요청마다) (넘으면 429)
 *   기본값 60 · 3000 · 120 — 대시보드 변수로 바꿀 수 있음. /api/look(외형 그림)은 로그인 없이 되고 IP 제한만 (따로 1분 RATE_LOOK_MIN번, 기본 600)
 *   RATE_SITE_DAY를 넣으면 사이트 전체 하루 조회도 그 수에서 멈춤 (넥슨 개발 키 동안 450 추천). 하루는 한국 시간 자정에 바뀜
 *   그 밖에 로그인은 주소마다 1분 20번, 기록 저장은 계정마다 1분 40번
 *
 * 물욕 시세 (D1 데이터베이스 DB, 비밀값 ADMIN_PASSWORD 필요 — 없으면 시세 고치기는 꺼짐)
 *   GET  /api/loot-prices            날짜별 시세 전체  { hist:[{ d:'2026.10.03', p:{ 템이름: 억 } }], conf, ver } (누구나, 30초 기억)
 *   GET  /api/loot-ver               판 번호만 { ver } — 열어 둔 사이트가 1분마다 바뀌었는지 확인 (한 줄 읽기)
 *                                    안전장치: 접속 주소마다 1분에 전체 RATE_LOOT_MIN(60)번 · 판 번호 RATE_LOOT_VER_MIN(120)번 넘으면 잠깐 429
 *                                    관리 화면은 '한 벌 시세'(d=2000.01.01)만 저장하고, 저장할 때 예전 날짜 행은 지움
 *   POST /api/admin/login            { password } 비밀번호 확인
 *   POST /api/admin/prices           { d, p } 그 날짜 시세를 통째로 저장 (빈 목록은 거절)
 *   POST /api/admin/delete           { d } 그 날짜 시세 지우기 (관리 쿠키 또는 password 필요)
 *   POST /api/admin/logout           관리 쿠키 지우기
 *   POST /api/admin/state            관리 화면용: /api/loot-prices와 같은 내용을 기억 없이 바로 읽음
 *   POST /api/admin/beta             베타 열기: 이 기기에 30일짜리 베타 쿠키(mepuri_beta, Path=/beta)를 줌 (관리 쿠키 또는 password 필요)
 *
 * 베타 (/beta/) — 관리자만 보는 시험판. 화면 파일은 public이 아니라 beta/index.html을 Worker 안에 넣어서(import) 쿠키 없이는 절대 안 나감
 *   베타 쿠키가 맞으면 보여 주고, 없으면 정식 사이트(/)로 보냄. (public 폴더 파일은 Worker를 안 거치고 바로 나가서 거기엔 안 둠)
 *   베타 화면은 기록을 'mepuri-beta:' 칸에만 저장하고, 계정 저장(/api/state)·방문 통계(/api/stat)는 안 부름 (사이트 코드 BETA)
 *
 * 공유 링크 (연말 결산 · 10.28 링크 테스트, D1 표 share_links) — 결산 카드에 쓰는 숫자 요약만 저장 (원래 기록·가린 이름은 안 받음)
 *   POST /api/share/list    { dk }                 내 링크 목록 { links:[{id,o,title,at,exp,views}], max, days, mode, can, who }
 *   POST /api/share/create  { dk, o, data }        링크 만들기 → { id, at, exp, title }  (o = 옵션 {nm,lk,mt,tn,nk}, data = 결산 요약 V)
 *     링크 이름 tn: 'char' 대표 캐릭터(이름 보이기일 때만) · 'nick' 닉네임 nk(12자, 글자·숫자·띄어쓰기·기호 몇 개) · 'none' → 미리보기 제목 「○○님의 2026 메푸리 연말정산」
 *     미리보기: 작은 그림 카드(twitter:card summary) — 제목 · 짧은 설명(보스 N마리 · N주의 기록) · 연도별 정사각 그림(public/r/a/og<연도>.<해시>.jpg, 없으면 og.png)
 *   POST /api/share/delete  { dk, id }             내 링크 지우기
 *     dk = 사이트가 브라우저에 둔 무작위 기기 키 (로그인 안 한 사람의 링크 주인 확인용, 해시로만 저장)
 *     베타 화면은 /beta/api/share/… 로 부름 (베타 쿠키가 /beta에만 붙어서) → '관리자만' 모드에서 베타인지 확인
 *   GET  /r/<id>            링크 보기 화면 (누구나, 로그인 없이 카드만) — 화면 파일은 public/r/view.*.js·css, 데이터는 이 Worker가 넣음
 *                           검색엔진 막기 · 미리보기(og) 제목 · 본 횟수(미리보기 봇 빼고) · 30일 지난 링크는 '없거나 기간이 지난 링크'
 *   POST /api/admin/shares       관리 화면: 숫자(살아 있는 링크·오늘 만든 수·본 횟수) + 목록(주인 이메일은 일부만)
 *   POST /api/admin/share-del    { id } 관리자가 링크 지우기
 *   POST /api/admin/share-mode   { mode } 새 링크 만들기: 'off' 멈춤 · 'admin' 관리자만(베타) · 'all' 모두 (처음엔 'admin')
 *   POST /api/admin/conf             { k, v } 사이트 설정 저장 (v가 null이면 지워서 기본값으로)
 *                                    k='tiers'  물욕 등급 기준 { black, red, dia, gold, silver, bronze } (억 이상)
 *                                    k='lootOn' 보스·난이도마다 물욕 기록 창에 기본으로 켜 둘 템 { '보스이름|난이도': [템…] }
 *                                    k='crystal' 결정석 가격표·출시일·안내 { tables:[{from:{D,W,M},price}], open, notice } — 사이트는 없으면 페이지 안 기본 표
 *                                    k='marks'   그래프 점선 { auto:{날짜:{t,off}}, add:[{d,t}] } — 가격표 적용일 점선의 이름·숨김 + 직접 넣은 점선
 *                                    → GET /api/loot-prices 응답의 conf로 사이트에 전달
 *   POST /api/admin/stats            { days } 방문 통계 (최근 days일, 1~90) — 날짜별 조회수·실사용자·로그인·새 방문·체류, 가입자 수
 *
 * 방문 통계 (D1 데이터베이스 DB — 익명)
 *   POST /api/stat                   사이트가 보내는 방문 신호 { t:'pv'|'stay', v: 브라우저 무작위 번호, li, nw, s } → 늘 204
 *                                    같은 사이트(Origin)에서 온 것만, 봇 이름이 붙은 브라우저는 안 셈, 접속 주소마다 1분 20번까지 (메모리에서만 셈)
 *                                    번호는 해시로만 저장하고 IP는 저장 안 함. 180일 지난 날은 신호 100번에 한 번꼴·관리 화면에서 통계를 볼 때 지움
 *   관리 화면: /admin  (비밀번호를 5번 틀리면 그 주소에서 15분, 사이트 전체로 1시간에 30번 넘게 틀리면 막힘.
 *                      맞으면 30분짜리 관리 쿠키를 줘서 그동안은 비밀번호 없이 저장 — 비밀번호는 브라우저에 안 남김)
 */

const NEXON = 'https://open.api.nexon.com/maplestory/v1/';

// 같은 요청을 잠깐 기억해서 호출 한도를 아낌 (초 단위)
// ※ Cache API는 workers.dev 주소에선 저장이 안 되고, 내 도메인을 연결하면 동작함. 안 돼도 조회는 정상.
const TTL = { id: 60 * 60 * 24, basic: 60 * 10, scheduler: 60 * 5 };

// 베타 화면 (관리자만): Wrangler가 .html을 글자(Text)로 묶어 넣음 — 사이트 파일(public)이 아니라서 /beta 입구를 거치지 않고는 못 받음
import BETA_HTML from './beta/index.html';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);

    // 베타(관리자만): 쿠키를 확인하고 public/beta 파일을 보여 줌. 없으면 정식 사이트로
    if (url.pathname === '/beta' || url.pathname.startsWith('/beta/')) return beta(req, env, url, ctx);
    // 공유 링크 보기 화면 (/r/<id>). public/r/의 화면 파일(view.*.js·css)은 Worker 전에 사이트 파일로 나감
    if (url.pathname.startsWith('/r/')) return shareView(req, env, ctx, url);
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
    if (url.pathname === '/api/loot-prices' || url.pathname === '/api/loot-ver' || url.pathname.startsWith('/api/admin/')) {
      try { return await lootPrices(req, env, url, cors); }
      catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.code, e.message, e.retry ? { ...cors, 'retry-after': String(e.retry) } : {});
        return fail(500, 'SERVER', '서버 오류예요. 잠시 후 다시 시도해 주세요', {});
      }
    }
    // 방문 통계 신호: 응답은 늘 바로 204 (실패해도 사이트에 영향 없음). 본문은 응답 전에 읽고, 저장은 응답 뒤에
    if (url.pathname === '/api/stat') {
      if (req.method === 'POST' && env.DB) {
        try { const hitv = statGuard(req) ? await statRead(req, url) : null; if (hitv) ctx.waitUntil(statSave(env.DB, hitv).catch(() => {})); } catch (e) { /* 조용히 */ }
      }
      return new Response(null, { status: 204, headers: noStore() });
    }
    // 공유 링크 만들기·목록·지우기 (같은 사이트에서만, POST)
    if (url.pathname.startsWith('/api/share/')) return shareApi(req, env, ctx, url, false);
    if (req.method !== 'GET') return fail(405, 'METHOD', 'GET 요청만 받아요', cors);

    // 넥슨 조회: 로그인 확인 + 남발 방지 (외형 그림은 IP 제한만)
    // 계정·하루·사이트 한도는 넥슨을 실제로 부를 때(캐시에 없을 때)만 셈 → 아래 charge
    let me = null;
    if (url.pathname === '/api/look' || NEXON_PATHS.includes(url.pathname)) {
      try { me = await guardNexon(req, env, url.pathname !== '/api/look', url.pathname); }
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

    // 한 요청에서 넥슨을 여러 번 불러도(이름→ocid→기본 정보) 한도는 한 번만 셈
    let charged = false;
    // 손님(로그인 안 함)은 손님 풀에서, 로그인한 사람은 계정 한도에서 셈 — 둘 다 사이트 전체 한도도 셈
    const charge = me ? async () => { if (charged) return; charged = true; await (me.guest ? chargeGuest(env) : chargeNexon(env, me)); } : null;
    try {
      if (url.pathname === '/api/character') {
        const name = (url.searchParams.get('name') || '').trim();
        if (!name || name.length > 12) return fail(400, 'OPENAPI00004', '캐릭터 이름을 확인해 주세요', cors);
        let guest = null;
        if (me && me.guest) { // 손님: 찾을 때마다 접속 주소 하루 횟수를 셈 (기억해 둔 이름이어도 셈)
          const max = guestIp(env), n = await hit(env.DB, await guestKey(req), 86400, max, `로그인 없이 찾기는 하루 ${max}번까지예요. 구글 로그인하면 계속 찾을 수 있어요`, 'GUEST', true);
          guest = { left: Math.max(0, max - n), max };
        }
        const memo = guest ? await nameMemoGet(env.DB, name).catch(() => null) : null; // 기억해 둔 결과는 손님에게만 (로그인한 사람은 늘 최신)
        if (memo) return json(guest ? { ...memo, guest } : memo, 200, cors);
        const { ocid } = await nexon(env, ctx, 'id', { character_name: name }, TTL.id, charge);
        const basic = await nexon(env, ctx, 'character/basic', { ocid }, TTL.basic, charge);
        const out = slim(ocid, basic);
        if (env.DB) ctx.waitUntil(nameMemoPut(env.DB, name, out).catch(() => {}));
        return json(guest ? { ...out, guest } : out, 200, cors);
      }

      if (url.pathname === '/api/character/basic') {
        const ocid = url.searchParams.get('ocid');
        if (!ocid) return fail(400, 'OPENAPI00003', 'ocid가 필요해요', cors);
        // date=YYYY-MM-DD 를 붙이면 그날 기준 정보 (예: 챌린저스 월드에 있던 때의 월드 확인)
        const date = url.searchParams.get('date') || '';
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'OPENAPI00004', '날짜는 YYYY-MM-DD 형식이에요', cors);
        const basic = await nexon(env, ctx, 'character/basic', date ? { ocid, date } : { ocid }, date ? TTL.id : TTL.basic, charge);
        return json(slim(ocid, basic), 200, cors);
      }

      if (url.pathname === '/api/scheduler') {
        const ocid = url.searchParams.get('ocid');
        if (!ocid) return fail(400, 'OPENAPI00003', 'ocid가 필요해요', cors);
        const data = await nexon(env, ctx, 'scheduler/character-state', { ocid }, TTL.scheduler, charge);
        return json(data, 200, cors);
      }

      return fail(404, 'NOT_FOUND', '없는 주소예요', cors);
    } catch (e) {
      if (e instanceof NexonError) return fail(e.status, e.code, e.message, cors);
      if (e instanceof HttpError) return fail(e.status, e.code, e.message, e.retry ? { ...cors, 'retry-after': String(e.retry) } : cors);
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
async function nexon(env, ctx, path, params, ttl, charge) {
  const u = new URL(NEXON + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const cache = caches.default;
  const cacheKey = new Request(u.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  // 캐시에 없어서 넥슨을 실제로 부를 때만 한도를 씀. 한도 셈이 없으면(로그인 확인을 안 거친 길) 부르지 않음
  if (!charge) throw new NexonError(503, 'NO_AUTH', '로그인 확인 없이 넥슨을 부를 수 없어요');
  await charge();

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
    // guest: 로그인 없이 이름으로 찾을 수 있는 하루 횟수(접속 주소마다) — 0이면 손님 조회 없음
    return json({ auth: ready, googleClientId: ready ? env.GOOGLE_CLIENT_ID : null, guest: ready && guestDay(env) > 0 ? guestIp(env) : 0 }, 200, noStore());
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
    await ensureShareSchema(env.DB); // 공유 링크를 한 번도 안 만든 서버면 표부터 (없는 표를 지우면 계정 삭제가 실패하니)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM share_links WHERE user_id = ?1').bind(me.id), // 그 계정의 공유 링크도 바로 지움
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
async function guardNexon(req, env, needLogin, path) {
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
  if (!me) {
    if (path === '/api/character' && guestDay(env) > 0) return { guest: true }; // 이름으로 찾기만 손님 허용
    throw new HttpError(401, 'LOGIN', '구글 계정으로 로그인해야 캐릭터를 조회할 수 있어요');
  }
  return me;
}
// 손님 조회 한도: 손님 전체 하루(RATE_GUEST_DAY, 기본 100 · 0이면 끔) · 접속 주소마다 하루(RATE_GUEST_IP, 기본 3)
function guestDay(env) { const v = env.RATE_GUEST_DAY; if (v === undefined || v === null || String(v).trim() === '') return 100; const n = parseInt(v, 10); return n > 0 ? n : 0; }
function guestIp(env) { const n = parseInt(env.RATE_GUEST_IP, 10); return n > 0 ? n : 3; }
// 접속 주소는 IPv6면 앞 64비트(/64, 한 집·한 폰 단위)로 묶고, 해시로만 셈
async function guestKey(req) {
  const raw = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ip = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
  return 'gip:' + (await sha256('mepuri-gip:' + ip)).slice(0, 16);
}
async function chargeGuest(env) {
  await hit(env.DB, 'gsite', 86400, guestDay(env), '오늘은 로그인 없이 찾기를 다 썼어요. 구글 로그인하면 바로 찾을 수 있어요', 'GUEST', true);
  const site = parseInt(env.RATE_SITE_DAY, 10);
  if (site > 0) await hit(env.DB, 'site', 86400, site, '오늘 사이트 전체 조회 한도를 다 썼어요');
}
// 이름 → 찾은 결과를 12시간 기억 (같은 이름을 다시 찾으면 넥슨을 안 부름). 영문 이름은 대소문자 구분 없이
const NAME_MEMO_SEC = 12 * 3600;
let memoReady = false;
async function nameMemoGet(db, name) {
  if (!db) return null;
  if (!memoReady) { await db.prepare('CREATE TABLE IF NOT EXISTS name_memo (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)').run(); memoReady = true; }
  const r = await db.prepare('SELECT v, exp FROM name_memo WHERE k = ?1').bind(name.toLowerCase()).first();
  if (!r || r.exp < Math.floor(Date.now() / 1000)) return null;
  try { return JSON.parse(r.v); } catch { return null; }
}
async function nameMemoPut(db, name, out) {
  const now = Math.floor(Date.now() / 1000);
  if (!memoReady) { await db.prepare('CREATE TABLE IF NOT EXISTS name_memo (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)').run(); memoReady = true; }
  await db.prepare('INSERT INTO name_memo (k, v, exp) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, exp = ?3').bind(name.toLowerCase(), JSON.stringify(out), now + NAME_MEMO_SEC).run();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM name_memo WHERE exp < ?1').bind(now).run(); // 지난 것 가끔 청소
}
// 넥슨을 실제로 부를 때만 세는 한도: 계정 1분·하루, 사이트 전체 하루 (캐시에서 돌려준 응답은 안 셈)
async function chargeNexon(env, me) {
  const lim = (k, d) => { const n = parseInt(env[k], 10); return n > 0 ? n : d; };
  await hit(env.DB, 'u:' + me.id, 60, lim('RATE_USER_MIN', 60), '조회를 너무 자주 했어요');
  await hit(env.DB, 'ud:' + me.id, 86400, lim('RATE_USER_DAY', 3000), '오늘 조회 횟수를 다 썼어요');
  // 사이트 전체 하루 한도 (넣었을 때만): 넥슨 개발 키(하루 1,000건) 동안 한 사람이 다 써 버리는 걸 막음 (V3)
  const site = parseInt(env.RATE_SITE_DAY, 10);
  if (site > 0) await hit(env.DB, 'site', 86400, site, '오늘 사이트 전체 조회 한도를 다 썼어요');
}
// 고정 시간 칸(초)마다 횟수 세기. 넘으면 429 + 몇 초 뒤 다시
async function hit(db, key, sec, max, msg, code, bare) { // code: 오류 이름(기본 RATE) · bare: 'N시간 뒤에' 안 붙임. 돌려주는 값 = 이번까지 센 횟수
  // 하루 칸은 한국 시간 자정에 바뀜 (예전엔 UTC 자정 = 오전 9시) (V11)
  const off = sec >= 86400 ? 9 * 3600 : 0;
  const now = Math.floor(Date.now() / 1000), win = Math.floor((now + off) / sec), k = `${key}:${sec}:${win}`, reset = (win + 1) * sec - off;
  // 이미 한도를 넘은 칸이면 DB에 쓰지 않고 바로 거절 (무료 쓰기 한도 아끼기, V7)
  const cur = await db.prepare('SELECT n FROM api_rate WHERE k = ?1').bind(k).first();
  const tooMany = () => { const wait = reset - now, e = new HttpError(429, code || 'RATE', bare ? msg : `${msg}. ${wait >= 3600 ? Math.ceil(wait / 3600) + '시간' : wait >= 60 ? Math.ceil(wait / 60) + '분' : wait + '초'} 뒤에 다시 시도해 주세요`); e.retry = wait; return e; };
  if (cur && cur.n >= max) throw tooMany();
  const row = await db.prepare('INSERT INTO api_rate (k, n, reset) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(k, reset).first();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM api_rate WHERE reset < ?1').bind(now).run(); // 지난 칸 가끔 청소
  if (row && row.n > max) throw tooMany();
  return row ? row.n : 1;
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

  // 안전장치: 공개 조회를 한 접속 주소에서 비정상적으로 많이 부르면 잠깐 막음 (정상 사용은 1분에 1~2번)
  if (m === 'GET' && (p === '/api/loot-ver' || p === '/api/loot-prices')) guardLoot(req, env, p === '/api/loot-ver' ? 'v' : 'f');
  // 열어 둔 사이트가 1분마다 묻는 '바뀌었나?' — 한 줄만 읽음. 같은 서버(isolate) 안에선 10초 동안 기억
  if (p === '/api/loot-ver' && m === 'GET') {
    if (!VER_MEMO || Date.now() - VER_MEMO.at > VER_MEMO_MS) VER_MEMO = { at: Date.now(), ver: await lootVer(env.DB) };
    return json({ ver: VER_MEMO.ver }, 200, { ...cors, ...noStore() });
  }
  if (p === '/api/loot-prices' && m === 'GET') {
    // 새로고침을 연달아 해도 데이터베이스는 30초에 한 번만 읽음 (같은 서버 안에서 응답을 기억). 관리 화면에서 저장하면 바로 잊음
    if (!LOOT_MEMO || Date.now() - LOOT_MEMO.at >= LOOT_MEMO_MS) LOOT_MEMO = { at: Date.now(), body: await lootBody(env.DB) };
    return json(LOOT_MEMO.body, 200, { ...cors, 'cache-control': 'public, max-age=60' });
  }
  if (m !== 'POST') throw new HttpError(405, 'METHOD', 'POST 요청만 받아요');
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_OFF', '관리 비밀번호가 아직 설정되지 않았어요');
  // 다른 사이트 페이지에서 몰래 보내는 요청 막기 (Origin이 붙어 오면 같은 주소여야 함)
  const origin = req.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'ORIGIN', '다른 사이트에서는 요청할 수 없어요');

  const body = await readJson(req, p === '/api/admin/conf' ? 160 * 1024 : 64 * 1024); // 결정석 가격표는 표가 쌓이면 커져서 넉넉히 (안에서 다시 12만 자로 막음)
  if (p === '/api/admin/logout') return json({ ok: true }, 200, { ...noStore(), 'set-cookie': adminCookie('', 0) });
  const viaCookie = await adminCookieOk(req, env);
  if (!viaCookie && !body.password) throw new HttpError(401, 'LOGIN', '다시 로그인해 주세요 (관리 쿠키가 없거나 30분이 지났어요)'); // 틀린 횟수에 안 셈
  if (!viaCookie) await checkAdmin(req, env, typeof body.password === 'string' ? body.password : '');
  // 비밀번호로 들어오면 30분짜리 관리 쿠키를 줌 (비밀번호는 브라우저에 남기지 않음)
  const keep = viaCookie ? {} : { 'set-cookie': adminCookie(await adminToken(env, Date.now() + ADMIN_COOKIE_MIN * 60000), ADMIN_COOKIE_MIN * 60) };

  if (p === '/api/admin/login') return json({ ok: true, min: ADMIN_COOKIE_MIN }, 200, { ...noStore(), ...keep });
  if (p === '/api/admin/beta') { // 베타 열기: 이 기기에 30일짜리 베타 쿠키 (관리 쿠키를 새로 줄 때는 둘 다)
    const h = new Headers({ 'content-type': 'application/json; charset=utf-8', ...noStore() });
    if (keep['set-cookie']) h.append('set-cookie', keep['set-cookie']);
    h.append('set-cookie', betaCookie(await betaToken(env, Date.now() + BETA_DAYS * 864e5), BETA_DAYS * 86400));
    return new Response(JSON.stringify({ ok: true, days: BETA_DAYS }), { status: 200, headers: h });
  }
  if (p === '/api/admin/state') return json(await lootBody(env.DB), 200, { ...noStore(), ...keep }); // 관리 화면: 기억해 둔 값 말고 바로 지금 값
  if (p === '/api/admin/conf') { // { k, v } 사이트 설정 하나 저장 · v가 null이면 지워서 기본값으로
    const k = String(body.k || '');
    if (!CONF_KEYS.includes(k)) throw new HttpError(400, 'CONF', '없는 설정이에요');
    if (body.v === null) { await env.DB.prepare('DELETE FROM site_conf WHERE k = ?1').bind(k).run(); await bumpVer(env.DB); return json({ ok: true, k, reset: true }, 200, { ...noStore(), ...keep }); }
    const v = k === 'tiers' ? confTiers(body.v) : k === 'crystal' ? confCrystal(body.v) : k === 'marks' ? confMarks(body.v) : k === 'presets' ? confPresets(body.v) : confLootOn(body.v);
    await env.DB.prepare('INSERT INTO site_conf (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, updated_at = ?3')
      .bind(k, JSON.stringify(v), new Date().toISOString()).run();
    await bumpVer(env.DB);
    return json({ ok: true, k, v }, 200, { ...noStore(), ...keep });
  }
  if (p === '/api/admin/stats') return json(await statReport(env.DB, body.days), 200, { ...noStore(), ...keep });
  if (p === '/api/admin/shares') return json(await shareAdminList(env.DB), 200, { ...noStore(), ...keep });
  if (p === '/api/admin/share-del') {
    const id = String(body.id || '');
    if (!SHARE_ID.test(id)) throw new HttpError(400, 'ID', '링크 주소가 이상해요');
    await ensureShareSchema(env.DB);
    const r = await env.DB.prepare('DELETE FROM share_links WHERE id = ?1').bind(id).run();
    return json({ ok: true, deleted: !!(r.meta && r.meta.changes) }, 200, { ...noStore(), ...keep });
  }
  if (p === '/api/admin/share-mode') {
    const mode = String(body.mode || '');
    if (!SHARE_MODES.includes(mode)) throw new HttpError(400, 'MODE', '없는 설정이에요');
    await env.DB.prepare("INSERT INTO site_conf (k, v, updated_at) VALUES ('share', ?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?1, updated_at = ?2").bind(mode, new Date().toISOString()).run();
    SHARE_MODE_MEMO = null;
    return json({ ok: true, mode }, 200, { ...noStore(), ...keep });
  }
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
    await bumpVer(env.DB);
    return json({ ok: true, d, count: rows.length }, 200, { ...noStore(), ...keep });
  }
  if (p === '/api/admin/delete') {
    await (d === ALL_DAY ? env.DB.prepare('DELETE FROM loot_prices') : env.DB.prepare('DELETE FROM loot_prices WHERE d = ?1').bind(d)).run();
    await bumpVer(env.DB);
    return json({ ok: true, d }, 200, { ...noStore(), ...keep });
  }
  throw new HttpError(404, 'NOT_FOUND', '없는 주소예요');
}

// 시세 + 사이트 설정 + 판 번호 한 벌 (공개 조회와 관리 화면이 같이 씀)
async function lootBody(db) {
  const { results } = await db.prepare('SELECT d, item, price FROM loot_prices ORDER BY d, item').all();
  const by = new Map();
  for (const r of results || []) { if (!by.has(r.d)) by.set(r.d, {}); by.get(r.d)[r.item] = r.price; }
  // 관리 화면에서 정한 사이트 설정 (기본 물욕템·등급 기준). 없으면 빈 칸 → 사이트는 페이지 안 기본값
  const conf = {}; let ver = '0';
  const cr = await db.prepare('SELECT k, v FROM site_conf').all();
  for (const r of cr.results || []) {
    if (r.k === 'ver') ver = r.v;
    else if (CONF_KEYS.includes(r.k)) { try { conf[r.k] = JSON.parse(r.v); } catch (e) { /* 깨진 값은 무시 */ } }
  }
  const body = { hist: [...by].map(([d, pr]) => ({ d, p: pr })), conf, ver };
  return body;
}
// 공개 조회 안전장치 — 데이터베이스에 안 쓰고 서버 메모리에서만 셈 (무료 쓰기 한도를 안 씀)
//  접속 주소(IPv6는 /64 묶음)마다 1분에 전체 조회 RATE_LOOT_MIN번(기본 60), 판 번호 RATE_LOOT_VER_MIN번(기본 120)
//  PC방처럼 한 주소를 여럿이 써도 넉넉한 수. 넘으면 그 1분이 끝날 때까지 429
//  ※ Cloudflare는 서버를 여러 개 띄울 수 있어서 정확한 수는 아니고 '과한 것만 막는' 정도
const LOOT_HITS = new Map();
function guardLoot(req, env, kind) {
  const raw = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ip = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') + '::/64' : raw;
  const lim = parseInt(env[kind === 'v' ? 'RATE_LOOT_VER_MIN' : 'RATE_LOOT_MIN'], 10) || (kind === 'v' ? 120 : 60);
  const now = Date.now(), win = Math.floor(now / 60000), k = kind + ':' + ip;
  if (LOOT_HITS.size > 5000) for (const [kk, v] of LOOT_HITS) if (v.win !== win) LOOT_HITS.delete(kk); // 지난 칸 정리
  let h = LOOT_HITS.get(k);
  if (!h || h.win !== win) { h = { win, n: 0 }; LOOT_HITS.set(k, h); }
  if (++h.n > lim) {
    const wait = Math.max(1, Math.ceil(((win + 1) * 60000 - now) / 1000));
    const e = new HttpError(429, 'RATE', `요청이 너무 많아요. ${wait}초 뒤에 다시 시도해 주세요`); e.retry = wait; throw e;
  }
}

// 시세·설정 판 번호 (site_conf의 'ver'): 관리 화면에서 저장할 때마다 바뀜 → 열어 둔 사이트가 1분마다 비교해서 바뀌었을 때만 다시 받음
let LOOT_MEMO = null, VER_MEMO = null;
const LOOT_MEMO_MS = 30000, VER_MEMO_MS = 10000;
async function lootVer(db) { const r = await db.prepare("SELECT v FROM site_conf WHERE k = 'ver'").first(); return r ? String(r.v) : '0'; }
async function bumpVer(db) {
  await db.prepare("INSERT INTO site_conf (k, v, updated_at) VALUES ('ver', ?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?1, updated_at = ?2")
    .bind(String(Date.now()), new Date().toISOString()).run();
  LOOT_MEMO = null; VER_MEMO = null;
}

// 사이트 설정 (관리 화면)
//   tiers  : 물욕 등급 기준 { black, red, dia, gold, silver, bronze } 억 이상 — 위 등급일수록 커야 함
//   lootOn : 보스·난이도마다 물욕 기록 창에 기본으로 켜 둘 템 { '보스이름|난이도': [템이름…] } — 적은 칸만 바뀌고 나머지는 페이지 기본값
const CONF_KEYS = ['tiers', 'lootOn', 'crystal', 'marks', 'presets'], TIER_KEYS = ['black', 'red', 'dia', 'gold', 'silver', 'bronze'];
function confTiers(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'TIERS', '등급 기준이 이상해요');
  const out = {}; let prev = Infinity;
  for (const t of TIER_KEYS) {
    const n = typeof v[t] === 'number' ? v[t] : typeof v[t] === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v[t]) ? Number(v[t]) : NaN;
    if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new HttpError(400, 'TIERS', `${t} 기준은 0보다 크고 10만 이하인 숫자로 적어 주세요 (억 단위)`);
    if (n >= prev) throw new HttpError(400, 'TIERS', '위 등급일수록 기준 금액이 커야 해요');
    out[t] = prev = Math.round(n * 1000) / 1000;
  }
  return out;
}
// 결정석 가격표 { tables:[{ from:{D,W,M}, price:{보스:{난이도:메소|null}} }], open:{'보스' 또는 '보스|난이도': 날짜}, notice:{id,text} }
//  가격표는 적용일(일간·주간 W 기준) 순서대로, 메소는 0 ~ 1000억 정수 또는 null(가격 미정)
const DIFFS = ['easy', 'normal', 'hard', 'chaos', 'extreme'];
function confCrystal(v) {
  const bad = m => new HttpError(400, 'CRYSTAL', m);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('결정석 가격 설정이 이상해요');
  if (JSON.stringify(v).length > 120000) throw bad('결정석 가격 설정이 너무 커요');
  const day = d => typeof d === 'string' && d !== ALL_DAY && validDay(d);
  if (!Array.isArray(v.tables) || !v.tables.length || v.tables.length > 60) throw bad('가격표가 없거나 너무 많아요');
  const tables = []; let prev = null;
  for (const [i, t] of v.tables.entries()) {
    const f = t && t.from;
    if (!f || !day(f.D) || !day(f.W) || !day(f.M)) throw bad(`${i + 1}번째 가격표의 적용일이 이상해요 (2026.10.22 모양)`);
    if (prev && !(f.W > prev.W && f.D > prev.D && f.M >= prev.M)) throw bad(`${i + 1}번째 가격표의 적용일은 앞 가격표보다 뒤여야 해요`);
    if (!t.price || typeof t.price !== 'object' || Array.isArray(t.price)) throw bad(`${i + 1}번째 가격표에 가격이 없어요`);
    const price = {}, ids = Object.keys(t.price);
    if (ids.length > 120) throw bad('보스가 너무 많아요');
    for (const id of ids) {
      if (!/^[a-z0-9]{1,24}$/.test(id)) throw bad('보스 이름이 이상해요: ' + String(id).slice(0, 24));
      const row = t.price[id]; if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('가격이 이상해요: ' + id);
      price[id] = {};
      for (const [d, x] of Object.entries(row)) {
        if (!DIFFS.includes(d)) throw bad(`난이도가 이상해요: ${id} ${String(d).slice(0, 12)}`);
        if (x !== null && !(Number.isInteger(x) && x >= 0 && x <= 1e11)) throw bad(`가격은 0 ~ 1000억 사이 정수(메소)로 적어 주세요: ${id} ${d}`);
        price[id][d] = x;
      }
    }
    tables.push({ from: { D: f.D, W: f.W, M: f.M }, price }); prev = f;
  }
  const open = {};
  if (v.open != null) {
    if (typeof v.open !== 'object' || Array.isArray(v.open) || Object.keys(v.open).length > 120) throw bad('출시일 설정이 이상해요');
    for (const [k, d] of Object.entries(v.open)) {
      if (!/^[a-z0-9]{1,24}(\|(easy|normal|hard|chaos|extreme))?$/.test(k) || !day(d)) throw bad('출시일이 이상해요: ' + String(k).slice(0, 30));
      open[k] = d;
    }
  }
  let notice = null;
  if (v.notice != null) {
    const n = v.notice;
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !/^[\w.-]{1,40}$/.test(n.id) || typeof n.text !== 'string') throw bad('안내 문구가 이상해요');
    const text = n.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300) throw bad('안내 문구는 1 ~ 300자로 적어 주세요');
    notice = { id: n.id, text };
  }
  return notice ? { tables, open, notice } : { tables, open };
}
// 그래프 점선 { auto:{'2026.09.17':{t:'이름', off:true}}, add:[{d:'2026.08.20', t:'벨로나 출시'}] } — 이름은 1~10자
// 추천 프리셋 (관리 화면에서 고침): {list:[{id,name,desc,slots:'보스:난이도[*인원] …',icon?,hide?}]} — 사이트는 이 목록으로 기본 추천 프리셋을 바꿔 보여 줌
function confPresets(v) {
  const bad = m => new HttpError(400, 'PRESETS', m);
  if (!v || typeof v !== 'object' || !Array.isArray(v.list) || v.list.length > 40) throw bad('프리셋 목록이 이상해요');
  const ids = new Set(), TOK = /^[a-z0-9_]{1,24}:[enhcx](\*[1-6])?$/;
  const list = v.list.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad(`${i + 1}번째 프리셋이 이상해요`);
    const id = String(p.id || ''); if (!/^[a-z0-9_-]{1,24}$/i.test(id) || ids.has(id)) throw bad(`${i + 1}번째 프리셋 id가 이상해요`); ids.add(id);
    const name = typeof p.name === 'string' ? p.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 24) throw bad(`${i + 1}번째 프리셋 이름은 1 ~ 24자로 적어 주세요`);
    const desc = typeof p.desc === 'string' ? p.desc.replace(/\s+/g, ' ').trim() : '';
    if (desc.length > 120) throw bad(`'${name}' 설명이 너무 길어요 (120자까지)`);
    const toks = typeof p.slots === 'string' ? p.slots.trim().split(/\s+/).filter(Boolean) : [];
    if (!toks.length || toks.length > 14 || toks.some(t => !TOK.test(t))) throw bad(`'${name}' 보스 목록이 이상해요`);
    const boss = toks.map(t => t.split(':')[0]); if (new Set(boss).size !== boss.length) throw bad(`'${name}'에 같은 보스가 두 번 있어요`);
    const o = { id, name, desc, slots: toks.join(' ') };
    if (p.icon != null && p.icon !== '') { if (typeof p.icon !== 'string' || !boss.includes(p.icon)) throw bad(`'${name}' 대표 그림은 목록에 있는 보스여야 해요`); o.icon = p.icon; }
    if (p.hide === true) o.hide = true;
    return o;
  });
  return { list };
}
function confMarks(v) {
  const bad = m => new HttpError(400, 'MARKS', m);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('점선 설정이 이상해요');
  const day = d => typeof d === 'string' && d !== ALL_DAY && validDay(d);
  const txt = (t, opt) => { if (t == null && opt) return ''; if (typeof t !== 'string') throw bad('점선 이름이 이상해요'); const x = t.replace(/\s+/g, ' ').trim(); if ((!x && !opt) || x.length > 10) throw bad('점선 이름은 1 ~ 10자로 적어 주세요'); return x; };
  const auto = {}, add = [];
  if (v.auto != null) {
    if (typeof v.auto !== 'object' || Array.isArray(v.auto) || Object.keys(v.auto).length > 60) throw bad('점선 설정이 이상해요');
    for (const [d, o] of Object.entries(v.auto)) {
      if (!day(d) || !o || typeof o !== 'object' || Array.isArray(o)) throw bad('점선 날짜가 이상해요: ' + String(d).slice(0, 12));
      const t = txt(o.t, true), off = o.off === true;
      if (t || off) auto[d] = off ? (t ? { t, off } : { off }) : { t };
    }
  }
  if (v.add != null) {
    if (!Array.isArray(v.add) || v.add.length > 30) throw bad('직접 넣은 점선이 너무 많아요 (30개까지)');
    const seen = new Set();
    for (const o of v.add) {
      if (!o || typeof o !== 'object' || !day(o.d)) throw bad('점선 날짜는 2026.10.22 모양으로 적어 주세요');
      if (seen.has(o.d)) throw bad(`${o.d} 점선이 두 번 들어 있어요`); seen.add(o.d);
      add.push({ d: o.d, t: txt(o.t, false) });
    }
    add.sort((a, b) => (a.d < b.d ? -1 : 1));
  }
  return { auto, add };
}
function confLootOn(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'LOOT_ON', '기본 물욕템 설정이 이상해요');
  const out = {}, bosses = Object.entries(v);
  if (bosses.length > 200) throw new HttpError(400, 'LOOT_ON', '보스가 너무 많아요');
  for (const [b, list] of bosses) {
    const name = String(b).trim();
    if (!name || name.length > 40 || !Array.isArray(list) || list.length > 80) throw new HttpError(400, 'LOOT_ON', '기본 물욕템 설정이 이상해요: ' + name.slice(0, 20));
    const items = [...new Set(list.map(x => String(x).replace(/\s+/g, ' ').trim()))];
    if (items.some(x => !x || x.length > 60)) throw new HttpError(400, 'LOOT_ON', '템 이름이 이상해요 (' + name.slice(0, 20) + ')');
    out[name] = items;
  }
  return out;
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

// 베타 쿠키: 관리 쿠키와 같은 방식(만료 시각 + 관리 비밀번호로 만든 HMAC)이지만 서명 앞말이 달라서 서로 못 바꿔 씀. 비밀번호를 바꾸면 무효
const BETA_COOKIE = 'mepuri_beta', BETA_DAYS = 30;
const betaCookie = (v, maxAge) => `${BETA_COOKIE}=${v}; Path=/beta; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function betaSig(env, exp) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('mepuri-beta|' + String(env.ADMIN_PASSWORD)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(exp)))));
}
async function betaToken(env, exp) { return exp + '.' + await betaSig(env, exp); }
async function betaOk(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const v = readCookie(req, BETA_COOKIE); if (!v) return false;
  const [exp, sig] = v.split('.'); const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() || e > Date.now() + BETA_DAYS * 864e5 + 60000 || !sig) return false;
  return sig === await betaSig(env, e);
}
async function beta(req, env, url, ctx) {
  if (url.pathname.startsWith('/beta/api/share/')) return shareApi(req, env, ctx, url, await betaOk(req, env)); // 베타 화면의 공유 링크 (베타 쿠키 확인은 '관리자만' 모드에서)
  if (!(await betaOk(req, env))) return new Response(null, { status: 302, headers: { location: '/', ...noStore() } }); // 관리자 아니면 정식 사이트로
  if (url.pathname !== '/beta/') return new Response(null, { status: 307, headers: { location: '/beta/', ...noStore() } }); // 화면은 /beta/ 하나
  return new Response(BETA_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', ...noStore() } }); // 검색에 안 걸리게 · 늘 새 화면
}

// ── 공유 링크 (연말 결산) ──
// 링크 주인: 로그인했으면 계정(user_id) · 안 했으면 기기(dk의 해시 dev). 링크는 만든 날부터 30일 — 넥슨 데이터(이름·코디 등)를 오래 두지 않으려고 (링크 내용은 만든 날 그대로)
// 남발 방지: 주인마다 살아 있는 링크 5개 · 로그인 안 함은 접속 주소(IPv6 /64)마다 하루 5개 · 계정마다 하루 20개 · 사이트 전체 하루 1000개
// 지우기: 예약 작업 없이 — 30일 지난 링크는 그 순간부터 안 보이고, 데이터는 링크를 만들거나 관리 화면을 열거나 지난 링크를 열 때 지움
const SHARE_DAYS = 30, SHARE_MAX = 5, SHARE_GUEST_DAY = 5, SHARE_USER_DAY = 20, SHARE_SITE_DAY = 1000, SHARE_MAX_BODY = 72 * 1024;
const SHARE_ID = /^[A-Za-z0-9]{10}$/, SHARE_MODES = ['off', 'admin', 'all'];
// 링크 보기 화면 파일 (public/r/) — build_view.py가 만든 파일 이름(내용 해시)으로 바꿔 넣음
// 링크 미리보기 작은 그림 (정사각 600×600, 연도별) — build_view.py가 만든 파일 이름으로 바꿔 넣음. 없는 해는 사이트 그림(og.png)
const SHARE_OG = { 2025: '/r/a/og2025.196aeccbe9.jpg', 2026: '/r/a/og2026.fccda8118b.jpg', 2027: '/r/a/og2027.5cc5e51301.jpg', 2028: '/r/a/og2028.1894725dc9.jpg' };
const SHARE_VIEW = { js: '/r/a/view.0b89028662.js', css: '/r/a/view.2622ffcfca.css' };
// 본 횟수에서 빼는 것: 링크 미리보기·검색 봇 (카톡·디스코드·슬랙·트위터·텔레그램·페이스북…)
const SHARE_BOT = /bot|crawl|spider|slurp|facebookexternalhit|kakaotalk-scrap|kakaostory-og|whatsapp|skypeuripreview|embedly|headless|lighthouse|curl|wget|python|axios|node-fetch|undici|go-http|okhttp|java\//i;
const SHARE_LOOK = /^https:\/\/open\.api\.nexon\.com\/static\/maplestory\/character\/look\/[A-Za-z0-9._~%\/-]+(\?[A-Za-z0-9._~%=&-]*)?$/;
const SHARE_OWN = '(user_id = ?1 OR (user_id IS NULL AND dev = ?2))'; // 지우기: 내 계정 링크 또는 이 기기 링크
let SHARE_MODE_MEMO = null;
async function shareMode(db) { // 'off' · 'admin'(관리자만 = 베타) · 'all'. 설정이 없으면 'admin'. 같은 서버 안에선 10초 기억
  if (SHARE_MODE_MEMO && Date.now() - SHARE_MODE_MEMO.at < 10000) return SHARE_MODE_MEMO.v;
  await ensurePriceSchema(db);
  const r = await db.prepare("SELECT v FROM site_conf WHERE k = 'share'").first();
  const v = r && SHARE_MODES.includes(r.v) ? r.v : 'admin';
  SHARE_MODE_MEMO = { at: Date.now(), v };
  return v;
}
const SHARE_HITS = new Map();
function shareGuard(req) { // 목록·지우기까지 포함해서 접속 주소마다 1분 60번 (메모리에서만 셈)
  const raw = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ip = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
  const now = Date.now(), win = Math.floor(now / 60000);
  if (SHARE_HITS.size > 5000) for (const [k, h] of SHARE_HITS) if (h.win !== win) SHARE_HITS.delete(k);
  let h = SHARE_HITS.get(ip); if (!h || h.win !== win) { h = { win, n: 0 }; SHARE_HITS.set(ip, h); }
  if (++h.n > 60) { const wait = Math.max(1, Math.ceil(((win + 1) * 60000 - now) / 1000)); const e = new HttpError(429, 'RATE', `요청이 너무 많아요. ${wait}초 뒤에 다시 시도해 주세요`); e.retry = wait; throw e; }
}
function shareId() { // 10자 (영문 대소문자·숫자 62가지, 고르게)
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = '';
  while (s.length < 10) for (const b of crypto.getRandomValues(new Uint8Array(16))) { if (b < 248 && s.length < 10) s += A[b % 62]; }
  return s;
}
// 옵션: 모르는 값은 가리는 쪽으로. 링크 이름 tn — 예전 화면(tn 없음)은 이름 보이기면 대표 캐릭터. 캐릭터 이름을 가렸으면 대표 캐릭터 이름도 제목에 안 씀
// 닉네임: 띄어쓰기 정리 후 1~12자, 글자·숫자·띄어쓰기와 기호 몇 개만 (주소·꺾쇠·보이지 않는 글자·한글 채움 문자 안 됨)
const SHARE_NICK = /^[\p{L}\p{N} _\-·~!?♡♥★☆^]{1,12}$/u, SHARE_FILL = /[\u115F\u1160\u3164\uFFA0]/;
function shareOpts(o) {
  o = o && typeof o === 'object' ? o : {};
  const r = { nm: o.nm === 'show' ? 'show' : 'hide', lk: o.lk === 'show' ? 'show' : 'job', mt: o.mt === 'show' ? 'show' : 'hide' };
  r.tn = ['char', 'nick', 'none'].includes(o.tn) ? o.tn : (r.nm === 'show' ? 'char' : 'none');
  if (r.tn === 'char' && r.nm !== 'show') r.tn = 'none';
  if (r.tn === 'nick') {
    const nk = typeof o.nk === 'string' ? o.nk.replace(/\s+/g, ' ').trim() : '';
    if (!SHARE_NICK.test(nk) || SHARE_FILL.test(nk)) throw new HttpError(400, 'NICK', '닉네임은 12자까지, 글자·숫자·띄어쓰기와 _ - · ~ ! ? ♡ ★ ^ 만 쓸 수 있어요');
    r.nk = nk;
  }
  return r;
}
const shareParse = t => { try { return JSON.parse(t); } catch { return null; } };
// 결산 요약 검사: 모양·크기만 (그리는 쪽에서도 하나하나 다시 확인). 바깥 주소는 넥슨 외형 그림(u)만
function shareClean(v) {
  const bad = m => new HttpError(400, 'SHARE_DATA', m || '결산 내용이 이상해요');
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  if (v.v !== 1 || !Number.isInteger(v.Y) || v.Y < 2020 || v.Y > 2100 || !Array.isArray(v.cs) || v.cs.length > 12) throw bad();
  let nodes = 0;
  const walk = (x, depth, key) => {
    if (++nodes > 8000) throw bad('결산 내용이 너무 커요');
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'number') { if (!Number.isFinite(x)) throw bad(); return; }
    if (typeof x === 'string') {
      if (key === 'u') { if (x.length > 1500 || !SHARE_LOOK.test(x)) throw bad('캐릭터 그림 주소가 이상해요'); return; }
      if (x.length > 200 || /[\u0000-\u001f\u007f]/.test(x) || /:\/\/|^\s*(data|javascript|vbscript):/i.test(x)) throw bad();
      return;
    }
    if (depth > 6) throw bad();
    if (Array.isArray(x)) { if (x.length > 120) throw bad(); for (const y of x) walk(y, depth + 1, key); return; }
    if (typeof x === 'object') {
      const ks = Object.keys(x);
      if (ks.length > (key === 'dayN' ? 400 : 80)) throw bad();
      for (const k of ks) { if (k.length > 24 || !/^[\w.]+$/.test(k)) throw bad(); walk(x[k], depth + 1, k); }
      return;
    }
    throw bad();
  };
  walk(v, 0, '');
  return v;
}
// 미리보기 제목: 링크 이름(대표 캐릭터 · 닉네임 · 안 넣기) + 「○○님의 2026 메푸리 연말정산」 (앱 안 화면은 '결산' 그대로, 링크만 연말정산)
function shareTitle(v, o) {
  let nm = '';
  if (o.tn === 'nick' && o.nk) nm = o.nk;
  else if (o.tn === 'char' && o.nm === 'show' && Array.isArray(v.chars) && v.chars[0] && Number.isInteger(v.chars[0].ci)) {
    const c = v.cs[v.chars[0].ci];
    if (c && typeof c.n === 'string') nm = c.n.replace(/[\u0000-\u001f\u007f<>"&]/g, '').trim().slice(0, 16);
  }
  return nm ? `${nm}님의 ${v.Y} 메푸리 연말정산` : `${v.Y} 메푸리 연말정산`;
}
let shareSchemaReady = false;
async function ensureShareSchema(db) {
  if (shareSchemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY, user_id INTEGER, dev TEXT, y INTEGER NOT NULL, o TEXT NOT NULL, title TEXT NOT NULL,
      data TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0)`),
    db.prepare('CREATE INDEX IF NOT EXISTS share_user ON share_links(user_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS share_dev ON share_links(dev)'),
    db.prepare('CREATE INDEX IF NOT EXISTS share_exp ON share_links(exp)'),
  ]);
  shareSchemaReady = true;
}
async function shareApi(req, env, ctx, url, isBeta) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD', 'POST 요청만 받아요');
    if (!env.DB) throw new HttpError(503, 'NO_DB', '데이터베이스가 아직 설정되지 않았어요');
    // 다른 사이트에서 쿠키를 이용해 몰래 보내는 요청 막기 (로그인·기록 저장과 같은 방식)
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'ORIGIN', '다른 사이트에서는 요청할 수 없어요');
    if (req.headers.get('x-mepuri') !== '1') throw new HttpError(403, 'HEADER', '잘못된 요청이에요');
    shareGuard(req);
    const op = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    if (!['list', 'create', 'delete'].includes(op)) throw new HttpError(404, 'NOT_FOUND', '없는 주소예요');
    await ensureSchema(env.DB); await ensureRateSchema(env.DB); await ensureShareSchema(env.DB);
    const body = await readJson(req, SHARE_MAX_BODY);
    const me = env.GOOGLE_CLIENT_ID ? await sessionUser(req, env) : null;
    const dk = typeof body.dk === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(body.dk) ? body.dk : '';
    const dev = dk ? (await sha256('mepuri-share|' + dk)).slice(0, 32) : '';
    const now = Date.now(), mode = await shareMode(env.DB), can = mode === 'all' || (mode === 'admin' && isBeta);
    const own = me ? 'user_id = ?1' : 'user_id IS NULL AND dev = ?1', ownV = me ? me.id : (dev || '-'); // 목록·개수: 로그인했으면 계정 링크, 안 했으면 이 기기 링크
    if (op === 'list') {
      const { results } = await env.DB.prepare(`SELECT id, o, title, at, exp, views FROM share_links WHERE ${own} AND exp >= ?2 ORDER BY at DESC LIMIT 20`).bind(ownV, now).all();
      const links = (results || []).map(r => ({ id: r.id, o: shareParse(r.o), title: r.title, at: r.at, exp: r.exp, views: r.views }));
      return json({ links, max: SHARE_MAX, days: SHARE_DAYS, mode, can, who: me ? 'user' : 'device' }, 200, noStore());
    }
    if (op === 'delete') {
      const id = String(body.id || '');
      if (!SHARE_ID.test(id)) throw new HttpError(400, 'ID', '링크 주소가 이상해요');
      const r = await env.DB.prepare(`DELETE FROM share_links WHERE id = ?3 AND ${SHARE_OWN}`).bind(me ? me.id : -1, dev || '-', id).run();
      if (!r.meta || !r.meta.changes) throw new HttpError(404, 'NOT_FOUND', '이미 지워졌거나 내 링크가 아니에요');
      return json({ ok: true }, 200, noStore());
    }
    // 만들기
    if (mode === 'off') throw new HttpError(503, 'SHARE_OFF', '지금은 새 링크를 만들 수 없어요');
    if (!can) throw new HttpError(403, 'SHARE_BETA', '아직 준비 중인 기능이에요');
    if (!me && !dev) throw new HttpError(400, 'DEVICE', '이 브라우저에서는 링크를 만들 수 없어요 (사이트 저장 공간을 못 써요). 로그인하면 만들 수 있어요');
    const o = shareOpts(body.o), data = shareClean(body.data), text = JSON.stringify(data);
    if (text.length > 64 * 1024) throw new HttpError(413, 'TOO_BIG', '결산 내용이 너무 커서 링크를 만들지 못했어요');
    await env.DB.prepare('DELETE FROM share_links WHERE exp < ?1').bind(now).run(); // 기간 지난 링크 정리
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM share_links WHERE ${own} AND exp >= ?2`).bind(ownV, now).first();
    if (cnt && cnt.n >= SHARE_MAX) throw new HttpError(409, 'SHARE_MAX', `링크는 ${SHARE_MAX}개까지예요. 하나 지우고 만들어 주세요`);
    if (me) await hit(env.DB, 'shu:' + me.id, 86400, SHARE_USER_DAY, '오늘은 링크를 너무 많이 만들었어요', 'RATE');
    else await hit(env.DB, 'shg:' + (await guestKey(req)).slice(4), 86400, SHARE_GUEST_DAY, `로그인하지 않으면 하루 ${SHARE_GUEST_DAY}개까지 만들 수 있어요. 내일 다시 하거나 로그인해 주세요`, 'RATE', true);
    await hit(env.DB, 'shsite', 86400, SHARE_SITE_DAY, '오늘은 사이트 전체에서 만들 수 있는 링크 수를 다 썼어요');
    const exp = now + SHARE_DAYS * 864e5, title = shareTitle(data, o);
    for (let t = 0; t < 4; t++) { // 같은 주소가 이미 있으면(아주 드묾) 다시 뽑음
      const id = shareId();
      const r = await env.DB.prepare('INSERT OR IGNORE INTO share_links (id, user_id, dev, y, o, title, data, at, exp, views) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)')
        .bind(id, me ? me.id : null, me ? null : dev, data.Y, JSON.stringify(o), title, text, now, exp).run();
      if (r.meta && r.meta.changes) return json({ id, at: now, exp, title }, 200, noStore());
    }
    throw new HttpError(500, 'SERVER', '링크를 만들지 못했어요. 다시 해 주세요');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message, e.retry ? { ...noStore(), 'retry-after': String(e.retry) } : noStore());
    return fail(500, 'SERVER', '서버 오류예요. 잠시 후 다시 시도해 주세요', noStore());
  }
}
// 관리 화면: 숫자 + 목록 (주인 이메일은 앞 두 글자만)
const maskEmail = e => { if (!e || typeof e !== 'string' || !e.includes('@')) return '(이메일 없음)'; const i = e.lastIndexOf('@'), a = e.slice(0, i); return (a.length <= 2 ? a.slice(0, 1) : a.slice(0, 2)) + '***' + e.slice(i); };
async function shareAdminList(db) {
  await ensureSchema(db); await ensureShareSchema(db);
  const now = Date.now(), k = kstDay(0), today = Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) - 9 * 3600000; // 한국 시간 오늘 0시
  await db.prepare('DELETE FROM share_links WHERE exp < ?1').bind(now).run();
  const s = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(views), 0) AS v, COALESCE(SUM(CASE WHEN at >= ?1 THEN 1 ELSE 0 END), 0) AS t FROM share_links').bind(today).first();
  const { results } = await db.prepare('SELECT s.id, s.user_id, s.o, s.title, s.at, s.exp, s.views, u.email FROM share_links s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.at DESC LIMIT 300').all();
  return {
    mode: await shareMode(db), max: SHARE_MAX, days: SHARE_DAYS, live: (s && s.n) || 0, today: (s && s.t) || 0, views: (s && s.v) || 0,
    links: (results || []).map(r => ({ id: r.id, o: shareParse(r.o), title: r.title, at: r.at, exp: r.exp, views: r.views, owner: r.user_id ? maskEmail(r.email) : null })),
  };
}
// 링크 보기 화면: 껍데기 HTML(미리보기 제목·검색 막기·보안 정책) + 결산 요약 데이터. 그리는 건 public/r/view.*.js
// (10.30 결산 v2: 곡 파일 /assets/rc2-bgm*.mp3를 fetch로 받아서 connect-src 'self' — 그 밖엔 서버에 아무것도 안 보냄)
const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHARE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://open.api.nexon.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const shareHead = () => ({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': SHARE_CSP });
async function shareView(req, env, ctx, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', ...noStore() } });
  const id = url.pathname.slice(3);
  let row = null;
  if (SHARE_ID.test(id) && env.DB) {
    try { await ensureShareSchema(env.DB); row = await env.DB.prepare('SELECT id, title, data, exp FROM share_links WHERE id = ?1').bind(id).first(); } catch (e) { row = null; }
  }
  if (!row || row.exp < Date.now()) {
    if (row) ctx.waitUntil(env.DB.prepare('DELETE FROM share_links WHERE id = ?1').bind(id).run().catch(() => {})); // 기간 지난 링크는 열어 볼 때도 지움
    return new Response(shareGoneHtml(), { status: 404, headers: shareHead() });
  }
  if (req.method === 'GET' && !SHARE_BOT.test(req.headers.get('User-Agent') || '')) ctx.waitUntil(env.DB.prepare('UPDATE share_links SET views = views + 1 WHERE id = ?1').bind(id).run().catch(() => {}));
  return new Response(shareHtml(row, url), { status: 200, headers: shareHead() });
}
function shareHtml(row, url) {
  const v = shareParse(row.data) || {}, n = x => (Number.isFinite(+x) ? Math.round(+x) : 0);
  // 미리보기: 디스코드 등은 작은 그림 카드(제목 · 짧은 설명 · 오른쪽 정사각 그림). 그 해 그림이 없으면 사이트 그림(가로)으로 큰 카드
  const og = SHARE_OG[n(v.Y)], img = url.origin + (og || '/og.png'), iw = og ? 600 : 1200, ih = og ? 600 : 630, card = og ? 'summary' : 'summary_large_image';
  const t = escH(row.title), d = escH(`보스 ${n(v.nK).toLocaleString('ko-KR')}마리 · ${n(v.nW)}주의 기록`), alt = escH(`${n(v.Y)} 메푸리 연말정산`);
  // JSON을 <script type="application/json">에 안전하게: </script>·<!--·줄 구분 문자를 바꿔 씀
  const data = row.data.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${t}</title>
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="description" content="${d}">
<meta property="og:type" content="website"><meta property="og:site_name" content="메푸리"><meta property="og:title" content="${t}"><meta property="og:description" content="${d}">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="${iw}"><meta property="og:image:height" content="${ih}"><meta property="og:image:alt" content="${alt}"><meta property="og:url" content="${url.origin}/r/${row.id}">
<meta name="twitter:card" content="${card}"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${img}">
<meta name="theme-color" content="#F68600"><link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800;900&display=swap">
<link rel="stylesheet" href="${SHARE_VIEW.css}">
<script id="rc-snap" type="application/json">${data}</script>
<script src="${SHARE_VIEW.js}" defer></script>
</head><body><noscript><p style="padding:24px;font-family:sans-serif">결산 카드를 보려면 자바스크립트를 켜 주세요. <a href="/">메푸리 열기</a></p></noscript></body></html>`;
}
function shareGoneHtml() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>없거나 기간이 지난 링크예요 · 메푸리</title><meta name="robots" content="noindex,nofollow"><link rel="icon" href="/favicon.ico">
<style>:root{color-scheme:light dark;--bg:#F1F4F6;--card:#fff;--text:#1E3043;--sub:#6C7784;--bd:rgba(0,0,0,.08)}@media (prefers-color-scheme:dark){:root{color-scheme:dark;color-scheme:only dark;--bg:#14161B;--card:#1E2128;--text:#ECEEF2;--sub:#A3ABB6;--bd:rgba(255,255,255,.07)}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:var(--bg);color:var(--text);font-family:"Noto Sans KR",system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;word-break:keep-all}
main{width:min(380px,100%);padding:28px 24px;border-radius:20px;background:var(--card);border:1px solid var(--bd);text-align:center}
b{display:block;font-size:13px;font-weight:800;letter-spacing:.06em;color:#F68600}h1{margin:10px 0 8px;font-size:21px}p{margin:0;font-size:14px;line-height:1.6;color:var(--sub)}
a{display:inline-flex;align-items:center;height:44px;margin-top:20px;padding:0 20px;border-radius:999px;background:#F68600;color:#fff;font-weight:800;text-decoration:none}</style></head>
<body><main><b>MEPURI</b><h1>없거나 기간이 지난 링크예요</h1><p>결산 공유 링크는 만든 날부터 ${SHARE_DAYS}일 동안만 볼 수 있어요.<br>만든 사람이 지웠을 수도 있어요.</p><a href="/">메푸리에서 내 결산 보기</a></main></body></html>`;
}

// ── 방문 통계 (익명) ──
// 사이트를 연 브라우저마다 무작위 번호(사이트가 만들어 브라우저에 둠)를 해시해서, 날짜(한국 시간)별로 한 줄씩:
//   pv 그날 화면을 연 횟수 · li 로그인한 채로 열었나 · nw 이 브라우저의 첫 방문이었나 · st 화면을 보고 있던 초 (하루 12시간까지)
// 신호 하나에 데이터베이스 쓰기 한 번. IP는 남발 방지로 메모리에서만 셈
const STAT_BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|curl|wget|python|axios|node-fetch|undici|go-http|okhttp|java\/|phantom/i;
const STAT_STAY_MAX = 3 * 3600, STAT_DAY_ST = 12 * 3600, STAT_KEEP_DAYS = 180;
let STAT_PRUNE_P = 0.01;
async function statRead(req, url) {
  // 다른 사이트에서 보낸 건 안 셈. Origin이 없는 브라우저는 같은 사이트 표시(Sec-Fetch-Site·Referer)로 확인
  const og = req.headers.get('Origin');
  if (og ? og !== url.origin : !(req.headers.get('Sec-Fetch-Site') === 'same-origin' || (req.headers.get('Referer') || '').startsWith(url.origin + '/'))) return null;
  const ua = req.headers.get('User-Agent') || '';
  if (!ua || STAT_BOT.test(ua)) return null;
  if (+(req.headers.get('content-length') || 0) > 512) return null;
  const text = await req.text(); if (text.length > 512) return null;
  let o; try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const v = typeof o.v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(o.v) ? o.v : null;
  if (!v) return null;
  if (o.t === 'pv') return { t: 'pv', v, li: o.li ? 1 : 0, nw: o.nw ? 1 : 0 };
  if (o.t === 'stay') { const s = Math.round(Number(o.s)); return s >= 1 ? { t: 'stay', v, s: Math.min(s, STAT_STAY_MAX) } : null; }
  return null;
}
const STAT_HITS = new Map();
function statGuard(req) { // 접속 주소(IPv6는 /64)마다 1분 20번까지 — 넘으면 조용히 안 셈
  const raw = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ip = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
  const win = Math.floor(Date.now() / 60000);
  if (STAT_HITS.size > 5000) for (const [k, h] of STAT_HITS) if (h.win !== win) STAT_HITS.delete(k);
  let h = STAT_HITS.get(ip); if (!h || h.win !== win) { h = { win, n: 0 }; STAT_HITS.set(ip, h); }
  return ++h.n <= 20;
}
async function statSave(db, x) {
  await ensureStatSchema(db);
  const d = kstDay(0), v = (await sha256('mepuri-vid:' + x.v)).slice(0, 16);
  if (Math.random() < STAT_PRUNE_P) await db.prepare('DELETE FROM stat_vis WHERE d < ?1').bind(kstDay(-STAT_KEEP_DAYS)).run(); // 180일 지난 날 가끔 청소
  if (x.t === 'pv') {
    await db.prepare('INSERT INTO stat_vis (d, v, li, nw, pv, st) VALUES (?1, ?2, ?3, ?4, 1, 0) ON CONFLICT(d, v) DO UPDATE SET pv = pv + 1, li = MAX(li, ?3)')
      .bind(d, v, x.li, x.nw).run();
  } else {
    await db.prepare('INSERT INTO stat_vis (d, v, li, nw, pv, st) VALUES (?1, ?2, 0, 0, 0, MIN(?3, ?4)) ON CONFLICT(d, v) DO UPDATE SET st = MIN(st + ?3, ?4)')
      .bind(d, v, x.s, STAT_DAY_ST).run();
  }
}
// 한국 시간 날짜 'YYYY.MM.DD' (add: 며칠 뒤/앞)
function kstDay(add, at) {
  const t = new Date((at ?? Date.now()) + 9 * 3600000 + (add || 0) * 86400000);
  return `${t.getUTCFullYear()}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${String(t.getUTCDate()).padStart(2, '0')}`;
}
async function statReport(db, daysIn) {
  await ensureStatSchema(db); await ensureSchema(db);
  const days = Math.min(90, Math.max(1, parseInt(daysIn, 10) || 30)), from = kstDay(-(days - 1));
  await db.prepare('DELETE FROM stat_vis WHERE d < ?1').bind(kstDay(-STAT_KEEP_DAYS)).run(); // 오래된 날 정리
  const r = await db.prepare(`SELECT d, COUNT(*) AS uv, SUM(pv) AS pv, SUM(li) AS li, SUM(nw) AS nw,
      SUM(CASE WHEN st > 0 THEN 1 ELSE 0 END) AS stn, SUM(st) AS st FROM stat_vis WHERE d >= ?1 GROUP BY d ORDER BY d`).bind(from).all();
  const uniq = async n => ((await db.prepare('SELECT COUNT(DISTINCT v) AS n FROM stat_vis WHERE d >= ?1').bind(kstDay(-(n - 1))).first()) || {}).n || 0;
  // 가입: users.created_at(ISO, UTC) → 한국 날짜로 묶음
  const since = new Date(Date.now() - (days + 1) * 86400000).toISOString();
  const ur = await db.prepare('SELECT created_at FROM users WHERE created_at >= ?1').bind(since).all();
  const join = {};
  for (const u of ur.results || []) { const t = Date.parse(u.created_at); if (Number.isFinite(t)) { const k = kstDay(0, t); if (k >= from) join[k] = (join[k] || 0) + 1; } }
  const tot = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  const rows = (r.results || []).map(x => ({ d: x.d, pv: x.pv || 0, uv: x.uv || 0, li: x.li || 0, nw: x.nw || 0, stn: x.stn || 0, st: x.st || 0 }));
  return { days, today: kstDay(0), rows, join, users: (tot && tot.n) || 0, u7: await uniq(7), u30: await uniq(30) };
}
let statSchemaReady = false;
async function ensureStatSchema(db) {
  if (statSchemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS stat_vis (
    d TEXT NOT NULL, v TEXT NOT NULL, li INTEGER NOT NULL DEFAULT 0, nw INTEGER NOT NULL DEFAULT 0,
    pv INTEGER NOT NULL DEFAULT 0, st INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (d, v))`).run();
  statSchemaReady = true;
}

let priceSchemaReady = false;
async function ensurePriceSchema(db) {
  if (priceSchemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS loot_prices (
      d TEXT NOT NULL, item TEXT NOT NULL, price REAL NOT NULL, updated_at TEXT, PRIMARY KEY (d, item))`),
    db.prepare('CREATE TABLE IF NOT EXISTS admin_fail (ip TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS site_conf (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT)'),
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
