import { clamp, cleanText, fetchJson, numberFrom, putBoundedMap } from "./util.mjs";

// 서울시 실거래가 API는 동(洞)으로는 못 거르고 구(區)까지만 걸러준다.
// 예전에는 그 구 필터를 안 쓰고 전체(32만 건)를 앞에서부터 1,000건씩 5번 훑으면서
// 원하는 동이 나오길 기다렸다. 1건 조회에 8초가 걸렸고, 그마저 5,000건을 훑어
// 겨우 1건을 건졌다. 이제 구로 걸러 한 번만 받고(0.3초), 동·유형은 받아온 것에서 고른다.
//
// 같은 구는 화면 안의 여러 물건이 공유하므로 구 단위로 캐시한다.
// (예전에는 캐시가 아예 없어서 같은 질문을 수십 번 그대로 다시 보냈다)
const DEALS_CACHE_TTL_MS = 10 * 60 * 1000;
const DEALS_CACHE_MAX = 40;
const dealsCache = new Map(); // 구 이름 -> { promise, expiresAt }

export async function fetchSeoulDeals(params) {
  const serviceKey = process.env.SEOUL_REAL_ESTATE_API_KEY || process.env.SEOUL_OPEN_API_KEY;
  const district = cleanText(params.get("district") || params.get("sgg") || "");
  const dong = cleanText(params.get("dong") || params.get("bjdong") || "");
  const type = cleanText(params.get("type") || "");
  const limit = clamp(numberFrom(params.get("limit")) || 3, 1, 10);
  const rows = clamp(numberFrom(params.get("rows")) || 1000, 1, 1000);

  if (!serviceKey) {
    return {
      ok: false,
      error: "missing_key",
      message: ".env에 SEOUL_REAL_ESTATE_API_KEY를 넣으면 서울시 부동산 실거래가 API를 호출합니다."
    };
  }

  let page = null;
  try {
    page = await getDistrictDeals(serviceKey, district, rows);
  } catch (error) {
    return {
      ok: false,
      error: "seoul_api_error",
      message: error?.message || "서울시 실거래가 API 응답을 읽지 못했습니다."
    };
  }

  const normalizedRows = page.deals;
  const totalCount = page.totalCount;

  // picks가 오면 한 구 안의 여러 (동·종별)을 한 번에 답한다.
  // 이 API는 구까지만 서버에서 거르고 동·종별은 받아온 것에서 고르는 구조라,
  // 같은 구를 동마다 다시 부르면 서버는 같은 장부를 반복해서 꺼낼 뿐이다.
  // (실측: 화면 하나에 구는 11개인데 조합이 32개라 32번 왕복했다)
  const picks = parsePicks(params.get("picks"));
  if (picks.length) {
    const results = {};
    for (const pick of picks) {
      results[`${pick.dong}|${pick.type}`] = pickDeals(normalizedRows, district, pick.dong, pick.type, limit);
    }

    return {
      ok: true,
      source: "서울시 부동산 실거래가 정보",
      district,
      totalCount,
      results,
      raw: { fetchedRows: normalizedRows.length, cached: page.cached, district, pickCount: picks.length }
    };
  }

  const single = pickDeals(normalizedRows, district, dong, type, limit);

  return {
    ok: true,
    source: "서울시 부동산 실거래가 정보",
    scope: single.scope,
    totalCount,
    matchedCount: single.deals.length,
    deals: single.deals,
    raw: {
      fetchedRows: normalizedRows.length,
      districtFiltered: Boolean(district),
      cached: page.cached,
      district,
      dong,
      type
    }
  };
}

// "창신동|빌라,체부동|오피스텔" → [{dong,type}, ...]
// 동이 비어 있는 조합도 있다(주소에 동이 없는 물건). 그건 빈 문자열 그대로 둔다.
function parsePicks(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.split("|"))
    .filter((parts) => parts.length === 2)
    .map(([dong, type]) => ({ dong: cleanText(dong), type: cleanText(type) }))
    .slice(0, 50);
}

// 받아온 구 하나치에서 동·종별로 고른다. 동이 안 맞으면 구 전체로 물러선다 —
// 그 동에 최근 거래가 없다고 아무것도 안 보여주면 판단할 근거가 사라진다.
function pickDeals(rows, district, dong, type, limit) {
  const typeMatches = rows.filter((deal) => matchesDealType(deal.usage, type));
  const districtMatches = typeMatches.filter((deal) => !district || deal.district === district);
  const dongMatches = districtMatches.filter((deal) => !dong || deal.dong === dong);
  const fallbackMatches = districtMatches.length ? districtMatches : typeMatches;

  return {
    scope: dongMatches.length && (district || dong) ? `${district} ${dong}`.trim() : district || "서울 전체",
    deals: (dongMatches.length ? dongMatches : fallbackMatches).slice(0, limit)
  };
}

// 구 하나치 실거래를 한 번만 받아 캐시한다. 같은 구의 다른 동·유형 요청은 이걸 재사용한다.
async function getDistrictDeals(serviceKey, district, rows) {
  const cacheKey = `${district || "__seoul_all__"}:${rows}`;
  const cached = dealsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...(await cached.promise), cached: true };
  }
  if (cached) dealsCache.delete(cacheKey);

  const task = (async () => {
    const result = await fetchSeoulDealPage(serviceKey, 1, rows, district);
    const bucket = result?.tbLnOpendataRtmsV;
    const code = (bucket?.RESULT || result?.RESULT)?.CODE || "";

    // INFO-200은 "해당 조건에 데이터 없음"이다. 오류가 아니므로 빈 결과로 캐시한다.
    if (code === "INFO-200") return { deals: [], totalCount: 0 };

    if (!Array.isArray(bucket?.row) || (code && code !== "INFO-000")) {
      throw new Error((bucket?.RESULT || result?.RESULT)?.MESSAGE || "서울시 실거래가 API 응답을 읽지 못했습니다.");
    }

    return {
      deals: bucket.row.map(normalizeSeoulDeal).filter(Boolean),
      totalCount: numberFrom(bucket.list_total_count)
    };
  })();

  const entry = { promise: task, expiresAt: Date.now() + DEALS_CACHE_TTL_MS };
  putBoundedMap(dealsCache, cacheKey, entry, DEALS_CACHE_MAX);
  // 실패한 조회가 10분간 눌러앉지 않도록 비운다.
  task.catch(() => {
    if (dealsCache.get(cacheKey) === entry) dealsCache.delete(cacheKey);
  });

  return { ...(await task), cached: false };
}

// 이 API의 검색 조건은 경로 위치로 정한다: 1번째 RCPT_YR, 2번째 CGG_CD, 3번째 CGG_NM.
// 동(STDG_NM)은 조건으로 안 받는다(실측 확인). 그래서 구까지만 서버에서 거르고
// 동은 받아온 목록에서 고른다. 빈 자리는 %20으로 채운다.
function fetchSeoulDealPage(serviceKey, start, end, district) {
  const base = `http://openapi.seoul.go.kr:8088/${serviceKey}/json/tbLnOpendataRtmsV/${start}/${end}/`;
  const path = district ? `%20/%20/${encodeURIComponent(district)}/` : "";
  return fetchJson(new URL(base + path));
}

function normalizeSeoulDeal(row) {
  const amount = numberFrom(row.THING_AMT) * 10000;
  const buildingArea = numberFrom(row.ARCH_AREA);
  const landArea = numberFrom(row.LAND_AREA);
  const area = buildingArea || landArea;

  if (!amount || !area) return null;

  return {
    date: formatDealMonth(row.CTRT_DAY),
    label: row.BLDG_NM || `${row.STDG_NM} ${row.BLDG_USG || "거래"}`,
    pricePerSqm: Math.round(amount / area),
    amount,
    area,
    district: row.CGG_NM || "",
    dong: row.STDG_NM || "",
    usage: row.BLDG_USG || "",
    floor: numberFrom(row.FLR) || null,
    builtYear: row.ARCH_YR || "",
    distanceLabel: `${row.CGG_NM || ""} ${row.STDG_NM || ""}`.trim(),
    source: "서울시 실거래가"
  };
}

function matchesDealType(usage, type) {
  if (!type) return true;
  if (type === "오피스텔") return usage.includes("오피스텔");
  if (type === "빌라") return usage.includes("연립") || usage.includes("다세대");
  if (type === "아파트") return usage.includes("아파트");
  if (type === "토지") return !usage || usage.includes("토지");
  return true;
}

function formatDealMonth(value) {
  const text = String(value || "");
  if (text.length < 6) return text || "거래일 확인";
  return `${text.slice(0, 4)}-${text.slice(4, 6)}`;
}
