import { clamp, cleanText, fetchJson, numberFrom } from "./util.mjs";

export async function fetchSeoulDeals(params) {
  const serviceKey = process.env.SEOUL_REAL_ESTATE_API_KEY || process.env.SEOUL_OPEN_API_KEY;
  const district = cleanText(params.get("district") || params.get("sgg") || "");
  const dong = cleanText(params.get("dong") || params.get("bjdong") || "");
  const type = cleanText(params.get("type") || "");
  const limit = clamp(numberFrom(params.get("limit")) || 3, 1, 10);
  const rows = clamp(numberFrom(params.get("rows")) || 1000, 1, 1000);
  const maxPages = clamp(numberFrom(params.get("pages")) || 5, 1, 10);

  if (!serviceKey) {
    return {
      ok: false,
      error: "missing_key",
      message: ".env에 SEOUL_REAL_ESTATE_API_KEY를 넣으면 서울시 부동산 실거래가 API를 호출합니다."
    };
  }

  const normalizedRows = [];
  let totalCount = 0;
  let apiResult = null;

  for (let page = 0; page < maxPages; page += 1) {
    const start = page * rows + 1;
    const end = (page + 1) * rows;
    const result = await fetchSeoulDealPage(serviceKey, start, end);
    const bucket = result?.tbLnOpendataRtmsV;
    apiResult = bucket?.RESULT || result?.RESULT || apiResult;

    if (!bucket?.row || (apiResult?.CODE && apiResult.CODE !== "INFO-000")) {
      return {
        ok: false,
        error: "seoul_api_error",
        message: apiResult?.MESSAGE || "서울시 실거래가 API 응답을 읽지 못했습니다.",
        raw: result
      };
    }

    totalCount = numberFrom(bucket.list_total_count) || totalCount;
    normalizedRows.push(...bucket.row.map(normalizeSeoulDeal).filter(Boolean));

    const exactDongCount = normalizedRows.filter(
      (deal) => matchesDealType(deal.usage, type) && (!district || deal.district === district) && (!dong || deal.dong === dong)
    ).length;
    if (!dong || exactDongCount >= limit) break;
  }

  const typeMatches = normalizedRows.filter((deal) => matchesDealType(deal.usage, type));
  const districtMatches = typeMatches.filter((deal) => !district || deal.district === district);
  const dongMatches = districtMatches.filter((deal) => !dong || deal.dong === dong);
  const fallbackMatches = districtMatches.length ? districtMatches : typeMatches;
  const picked = (dongMatches.length ? dongMatches : fallbackMatches).slice(0, limit);

  return {
    ok: true,
    source: "서울시 부동산 실거래가 정보",
    scope: dongMatches.length ? `${district} ${dong}`.trim() : district || "서울 전체",
    totalCount,
    matchedCount: picked.length,
    deals: picked,
    raw: {
      result: apiResult,
      fetchedRows: normalizedRows.length,
      district,
      dong,
      type
    }
  };
}

async function fetchSeoulDealPage(serviceKey, start, end) {
  const apiUrl = new URL(`http://openapi.seoul.go.kr:8088/${serviceKey}/json/tbLnOpendataRtmsV/${start}/${end}/`);
  return fetchJson(apiUrl);
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
