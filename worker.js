/**
 * 메푸리 API 서버 (Cloudflare Worker)
 * 넥슨 Open API 키를 서버에만 두고, 사이트는 캐릭터 이름만 보내서 조회한다.
 *
 * 필요한 설정 (Cloudflare 대시보드 → 이 Worker → 설정 → 변수 및 비밀)
 *   NEXON_API_KEY   (비밀, 필수)  openapi.nexon.com에서 받은 API 키
 *   ALLOWED_ORIGINS (선택)        허용할 사이트 주소, 쉼표로 구분. 비워두면 모든 사이트 허용(테스트용)
 *
 * 사이트(public 폴더)도 같이 올리면 이 Worker가 사이트와 API를 한 주소에서 같이 보여줌.
 *
 * 주소
 *   GET /api/health                    서버 확인
 *   GET /api/character?name=캐릭터명   이름 → 월드·레벨·직업·외형 이미지
 *   GET /api/character/basic?ocid=…    저장해 둔 ocid로 다시 불러오기(새로고침)
 *   GET /api/scheduler?ocid=…          인게임 스케줄러(보스 완료 여부) 원본 그대로
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
    if (req.method !== 'GET') return fail(405, 'METHOD', 'GET 요청만 받아요', cors);
    if (url.pathname === '/api/health') return json({ ok: true, service: 'mepuri-api' }, 200, cors);
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
        const basic = await nexon(env, ctx, 'character/basic', { ocid }, TTL.basic);
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

  const res = await fetch(u, { headers: { 'x-nxopen-api-key': env.NEXON_API_KEY } });
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
