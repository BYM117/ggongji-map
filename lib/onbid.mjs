import {
  clamp,
  fetchJson,
  firstValue,
  mapWithConcurrency,
  numberFrom,
  parseQueryString,
  putBoundedMap
} from "./util.mjs";
import { guessRegion, isPropertyInsideBounds, isRoughlyInsideBounds } from "./geo.mjs";
import { classifyItem, normalizeProperty } from "./normalize.mjs";
import { fetchVworldPoint, fetchVworldRegion } from "./vworld.mjs";

const DEFAULT_ONBID_API_URL = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2";
const DEFAULT_ONBID_QUERY = "resultType=json&prptDivCd=0007&pvctTrgtYn=N&dspsMthodCd=0001";

// 온비드 목록 API는 지역 필터(lctnSdnm/lctnSggnm)를 받아준다. 예전에는 그걸 안 쓰고
// 전국 54,849건을 앞에서부터 100건씩 10번 긁었다. 그 1,000건은 전국이 뒤섞여 있어서
// 화면 지역 물건이 사실상 없었고(서울은 100건 중 4건), 받아오는 데만 18초가 걸려
// 좌표를 채우기도 전에 30초 제한에 걸려 죽었다. 죽으니 캐시도 못 채워 매번 반복했다.
//
// 이제 화면이 걸친 시군구만 골라서 받는다. 구 하나면 100~200건이라 한 번에 끝난다.
const REGION_ROWS = 1000; // 이 API가 한 번에 주는 최대치. 100건씩 나눠 받을 이유가 없다.
const REGION_MAX_PAGES = 3;
const REGION_CACHE_TTL_MS = 10 * 60 * 1000;
const REGION_CACHE_MAX = 60;
// 온비드 물건은 좌표가 없어 주소로 하나씩 구해야 한다. 화면 하나에서 새로 구할 상한.
const GEOCODE_BUDGET = 120;

const cache = {
  regionRows: new Map(), // "시도|시군구" -> { promise, expiresAt }
  properties: new Map()
};

export function onbidEndpoint() {
  return process.env.ONBID_API_URL || DEFAULT_ONBID_API_URL;
}

export async function fetchOnbid(params) {
  const endpoint = onbidEndpoint();
  const serviceKey = process.env.ONBID_SERVICE_KEY;

  if (!endpoint || !serviceKey) {
    const missing = [!endpoint ? "ONBID_API_URL" : "", !serviceKey ? "ONBID_SERVICE_KEY" : ""].filter(Boolean);
    return {
      ok: false,
      error: "missing_onbid_config",
      message: `.env에 ${missing.join(", ")} 설정이 필요합니다.`
    };
  }

  const apiUrl = buildOnbidUrl(params);
  const result = await fetchJson(apiUrl);
  return { ok: true, source: "ONBID", raw: result };
}

export async function fetchOnbidProperties(params) {
  const endpoint = onbidEndpoint();
  const serviceKey = process.env.ONBID_SERVICE_KEY;

  if (!endpoint || !serviceKey) {
    const missing = [!endpoint ? "ONBID_API_URL" : "", !serviceKey ? "ONBID_SERVICE_KEY" : ""].filter(Boolean);
    return {
      ok: false,
      error: "missing_onbid_config",
      message: `.env에 ${missing.join(", ")} 설정이 필요합니다.`,
      rawCount: 0,
      mappedCount: 0,
      droppedCount: 0,
      properties: []
    };
  }

  if (endpoint.includes("OnbidRlstDtlSrvc2") && !params.get("cltrMngNo")) {
    return {
      ok: false,
      error: "missing_onbid_detail_key",
      message: "이 API는 온비드 부동산 물건상세 조회서비스라 cltrMngNo(물건관리번호)가 필요합니다. 지도용 전체 매물 반입에는 온비드 부동산 물건목록 조회서비스가 추가로 필요합니다.",
      rawCount: 0,
      mappedCount: 0,
      droppedCount: 0,
      properties: []
    };
  }

  const pageNo = Math.max(numberFrom(params.get("pageNo")) || 1, 1);
  const numOfRows = clamp(numberFrom(params.get("numOfRows")) || numberFrom(process.env.ONBID_NUM_OF_ROWS) || 100, 1, 100);
  const maxPages = clamp(numberFrom(params.get("maxPages")) || numberFrom(process.env.ONBID_MAX_PAGES) || 1, 1, 100);
  const maxProperties = clamp(
    numberFrom(params.get("maxProperties")) || numberFrom(process.env.ONBID_MAX_PROPERTIES) || numOfRows * maxPages,
    1,
    10000
  );
  const rows = [];
  let firstResult = null;
  let totalCount = 0;

  for (let offset = 0; offset < maxPages && rows.length < maxProperties; offset += 1) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("pageNo", String(pageNo + offset));
    pageParams.set("numOfRows", String(numOfRows));

    const result = await fetchJson(buildOnbidUrl(pageParams));
    if (!firstResult) firstResult = result;

    const errorPayload = makeOnbidErrorPayload(result, params);
    if (errorPayload) return errorPayload;

    const pageRows = extractRows(result);
    rows.push(...pageRows);
    totalCount = totalCount || extractTotalCount(result);

    if (pageRows.length < numOfRows) break;
    if (totalCount && pageNo + offset >= Math.ceil(totalCount / numOfRows)) break;
  }

  const limitedRows = rows.slice(0, maxProperties);
  const mapped = await mapWithConcurrency(limitedRows, 8, hydrateCachedOnbidRow);
  const properties = mapped.map(normalizeProperty).filter(Boolean);

  return {
    ok: true,
    source: "ONBID",
    message: rows.length ? "온비드 응답을 꽁지맵 물건으로 정규화했습니다." : "온비드 응답에서 물건 목록을 찾지 못했습니다.",
    rawCount: limitedRows.length,
    mappedCount: properties.length,
    droppedCount: Math.max(mapped.length - properties.length, 0),
    properties,
    diagnostics: {
      endpoint: endpoint.replace(process.env.ONBID_SERVICE_KEY, "***"),
      requiresCoordinates: true,
      pageNo,
      numOfRows,
      maxPages,
      totalCount
    },
    raw: params.get("includeRaw") === "1" ? firstResult : undefined
  };
}

export async function fetchOnbidViewportProperties(params, bounds) {
  const endpoint = onbidEndpoint();
  const serviceKey = process.env.ONBID_SERVICE_KEY;

  if (!endpoint || !serviceKey) {
    return {
      ok: false,
      source: "온비드",
      properties: [],
      diagnostics: {
        source: "onbid",
        candidateCount: 0,
        returnedCount: 0,
        message: "missing_onbid_config"
      }
    };
  }

  const regions = await regionsForBounds(bounds);
  if (!regions.length) {
    return {
      ok: true,
      source: "온비드",
      properties: [],
      diagnostics: { source: "onbid", regions: [], scannedRows: 0, candidateCount: 0, returnedCount: 0, message: "region_lookup_failed" }
    };
  }

  const rowSets = await Promise.all(
    regions.map((region) =>
      getRegionOnbidRows(params, region).catch((error) => {
        console.error("onbid region fetch failed", region.sido, region.sigungu, String(error?.message || "").slice(0, 80));
        return [];
      })
    )
  );
  const allRows = rowSets.flat();
  const roughRows = allRows.filter((row) => isRoughlyInsideBounds(mapOnbidRow(row), bounds));
  // 온비드는 같은 물건(cltrMngNo)을 입찰 회차마다 한 줄씩 보낸다. 실측으로 89줄이
  // 실제 13개 물건이었다. 좌표를 구하기 전에 걸러내지 않으면 아래 예산을 중복이 다 먹는다.
  const uniqueRows = dedupeOnbidRows(roughRows);
  // 좌표를 새로 구하는 건 물건당 왕복이라, 한 화면에서 무한정 늘어나지 않게 잘라둔다.
  const geocodeRows = uniqueRows.slice(0, GEOCODE_BUDGET);

  const mapped = await mapWithConcurrency(geocodeRows, 8, hydrateCachedOnbidRow);
  const properties = mapped.map(normalizeProperty).filter(Boolean).filter((item) => isPropertyInsideBounds(item, bounds));
  return {
    ok: true,
    source: "온비드",
    properties,
    diagnostics: {
      source: "onbid",
      regions: regions.map((region) => `${region.sido} ${region.sigungu}`.trim()),
      scannedRows: allRows.length,
      candidateCount: roughRows.length,
      uniqueCount: uniqueRows.length,
      geocodedCount: geocodeRows.length,
      returnedCount: properties.length
    }
  };
}

function dedupeOnbidRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const mapped = mapOnbidRow(row);
    const key = mapped.id || `${mapped.caseNo}:${mapped.address}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 화면 하나가 여러 구에 걸치므로 가운데와 네 모서리를 각각 물어본다. 다섯 번 다 물어도
// 0.1초대이고, 좌표를 격자로 반올림해 캐시하므로 이어지는 이동은 대부분 캐시로 끝난다.
async function regionsForBounds(bounds) {
  const midLat = (bounds.swLat + bounds.neLat) / 2;
  const midLng = (bounds.swLng + bounds.neLng) / 2;
  const points = [
    [midLat, midLng],
    [bounds.swLat, bounds.swLng],
    [bounds.swLat, bounds.neLng],
    [bounds.neLat, bounds.swLng],
    [bounds.neLat, bounds.neLng]
  ];

  const found = await Promise.all(points.map(([lat, lng]) => fetchVworldRegion(lat, lng).catch(() => null)));
  const unique = new Map();
  for (const region of found) {
    if (!region?.sido) continue;
    unique.set(`${region.sido}|${region.sigungu}`, region);
  }
  return [...unique.values()];
}

// 시군구 하나치를 받아 캐시한다. 같은 구를 보는 다음 요청은 왕복 없이 끝난다.
async function getRegionOnbidRows(params, region) {
  const cacheKey = `${region.sido}|${region.sigungu}`;
  const cached = cache.regionRows.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) cache.regionRows.delete(cacheKey);

  const task = (async () => {
    const rows = [];
    let totalCount = 0;

    for (let page = 1; page <= REGION_MAX_PAGES; page += 1) {
      const pageParams = new URLSearchParams(params);
      pageParams.set("pageNo", String(page));
      pageParams.set("numOfRows", String(REGION_ROWS));
      pageParams.set("lctnSdnm", region.sido);
      if (region.sigungu) pageParams.set("lctnSggnm", region.sigungu);

      const result = await fetchJson(buildOnbidUrl(pageParams));
      if (makeOnbidErrorPayload(result, params)) break;

      const pageRows = extractRows(result);
      rows.push(...pageRows);
      totalCount = totalCount || extractTotalCount(result);

      if (pageRows.length < REGION_ROWS) break;
      if (totalCount && rows.length >= totalCount) break;
    }

    return rows;
  })();

  const entry = { promise: task, expiresAt: Date.now() + REGION_CACHE_TTL_MS };
  putBoundedMap(cache.regionRows, cacheKey, entry, REGION_CACHE_MAX);
  // 실패한 조회가 10분간 눌러앉지 않도록 비운다.
  task.catch(() => {
    if (cache.regionRows.get(cacheKey) === entry) cache.regionRows.delete(cacheKey);
  });

  return task;
}

async function hydrateCachedOnbidRow(row) {
  const mapped = mapOnbidRow(row);
  const cacheKey = mapped.id || `${mapped.caseNo}:${mapped.address}`;
  if (cache.properties.has(cacheKey)) return cache.properties.get(cacheKey);

  const hydrated = await hydrateOnbidRow(mapped);
  putBoundedMap(cache.properties, cacheKey, hydrated);
  return hydrated;
}

async function hydrateOnbidRow(row) {
  if (numberFrom(firstValue(row, ["lat", "latitude", "y"])) && numberFrom(firstValue(row, ["lng", "longitude", "x"]))) {
    return row;
  }

  const point = await fetchVworldPoint(row.address || row.title);
  if (!point) return row;

  return {
    ...row,
    lat: point.lat,
    lng: point.lng,
    pnu: point.pnu || row.pnu,
    geocodeSource: "주소 좌표 확인"
  };
}

export function makeOnbidErrorPayload(result, params) {
  if (result?.text) {
    const message = result.text.includes("Forbidden")
      ? "Forbidden: 인증키는 인식됐지만 이 온비드 API에 대한 호출 권한이 없습니다. 공공데이터포털에서 부동산 물건목록 조회서비스 활용신청/승인 상태를 확인하세요."
      : result.text;
    return {
      ok: false,
      error: "onbid_api_error",
      message,
      rawCount: 0,
      mappedCount: 0,
      droppedCount: 0,
      properties: [],
      raw: params.get("includeRaw") === "1" ? result : undefined
    };
  }

  const apiResult = result?.result || result?.header || result?.response?.header;
  if (apiResult?.resultCode && !["00", "INFO-000"].includes(String(apiResult.resultCode))) {
    return {
      ok: false,
      error: "onbid_api_error",
      message: apiResult.resultMsg || "온비드 API 응답 오류입니다.",
      rawCount: 0,
      mappedCount: 0,
      droppedCount: 0,
      properties: [],
      raw: params.get("includeRaw") === "1" ? result : undefined
    };
  }

  return null;
}

function buildOnbidUrl(params) {
  const endpoint = onbidEndpoint();
  const serviceKey = process.env.ONBID_SERVICE_KEY;
  const keyParam = process.env.ONBID_SERVICE_KEY_PARAM || "serviceKey";
  const apiUrl = new URL(resolveOnbidEndpoint(endpoint));

  apiUrl.searchParams.set(keyParam, serviceKey);
  apiUrl.searchParams.set("numOfRows", params.get("numOfRows") || process.env.ONBID_NUM_OF_ROWS || "50");
  apiUrl.searchParams.set("pageNo", params.get("pageNo") || "1");
  apiUrl.searchParams.set("_type", params.get("_type") || "json");
  apiUrl.searchParams.set("format", params.get("format") || "json");

  for (const [key, value] of parseQueryString(process.env.ONBID_DEFAULT_QUERY || DEFAULT_ONBID_QUERY).entries()) {
    if (!apiUrl.searchParams.has(key)) apiUrl.searchParams.set(key, value);
  }

  for (const [key, value] of params.entries()) {
    // 지도 좌표·표시 옵션은 이 API가 모르는 값이다. 그대로 실어 보내지 않는다.
    if (!["serviceKey", keyParam, "silent", "includeRaw", "maxPages", "maxProperties",
          "swLat", "swLng", "neLat", "neLng", "sources", "zoom", "exactGeocode",
          "onbidRows", "onbidPages"].includes(key)) {
      apiUrl.searchParams.set(key, value);
    }
  }

  return apiUrl;
}

function resolveOnbidEndpoint(endpoint) {
  const url = String(endpoint || "");
  if (url.includes("OnbidRlstListSrvc2") && !url.endsWith("/getRlstCltrList2")) {
    return `${url.replace(/\/$/, "")}/getRlstCltrList2`;
  }
  if (url.includes("OnbidRlstDtlSrvc2") && !url.endsWith("/getRlstDtlInf2")) {
    return `${url.replace(/\/$/, "")}/getRlstDtlInf2`;
  }
  return url;
}

function extractRows(payload) {
  const candidates = [
    payload?.response?.body?.items?.item,
    payload?.response?.body?.items,
    payload?.body?.items?.item,
    payload?.body?.items,
    payload?.items?.item,
    payload?.items,
    payload?.data,
    payload?.row,
    payload?.rows,
    payload?.list,
    payload?.result
  ];

  for (const candidate of candidates) {
    const rows = normalizeRowCandidate(candidate);
    if (rows.length) return rows;
  }

  return findFirstArray(payload);
}

function extractTotalCount(payload) {
  return numberFrom(
    payload?.response?.body?.totalCount ||
      payload?.body?.totalCount ||
      payload?.totalCount ||
      payload?.response?.body?.totalCnt ||
      payload?.totalCnt
  );
}

function normalizeRowCandidate(candidate) {
  if (Array.isArray(candidate)) return candidate.filter((item) => item && typeof item === "object");
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return [candidate];
  return [];
}

function findFirstArray(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return normalizeRowCandidate(value);

  for (const child of Object.values(value)) {
    const found = findFirstArray(child);
    if (found.length) return found;
  }

  return [];
}

function mapOnbidRow(row) {
  const address = firstValue(row, [
    "address",
    "addr",
    "소재지",
    "물건소재지",
    "GOODS_LCTN_ADDR",
    "goodsLctnAddr",
    "CLTR_NM",
    "cltrNm",
    "onbidCltrNm"
  ]) || buildOnbidAddress(row);
  const title = firstValue(row, ["title", "name", "물건명", "GOODS_NM", "goodsNm", "CLTR_NM", "cltrNm", "onbidCltrNm"]) || address;
  const category = firstValue(row, [
    "type",
    "category",
    "물건유형",
    "CTGR_FULL_NM",
    "ctgrFullNm",
    "GOODS_KND_NM",
    "goodsKndNm",
    "cltrUsgMclsCtgrNm",
    "cltrUsgSclsCtgrNm",
    "cltrUsgLclsCtgrNm"
  ]);

  const onbidClass = classifyItem({ category: String(category || ""), address, title });

  return {
    ...row,
    id: firstValue(row, ["id", "cltrMngNo", "CLTR_MNG_NO", "onbidCltrno", "PLNM_NO", "plnmNo", "PBCT_NO", "pbctNo", "CLTR_NO", "cltrNo"]) || "",
    caseNo: firstValue(row, ["cltrMngNo", "CLTR_MNG_NO", "onbidCltrno", "PLNM_NO", "plnmNo", "PBCT_NO", "pbctNo", "CLTR_NO", "cltrNo", "물건번호"]) || "온비드",
    title,
    type: onbidClass.type,
    categoryGroup: onbidClass.group,
    categorySub: onbidClass.sub,
    categoryConfident: onbidClass.confident,
    saleForm: onbidClass.saleForm,
    region: firstValue(row, ["region", "지역"]) || guessRegion(address),
    address,
    minBid: firstValue(row, [
      "MIN_BID_PRICE",
      "MIN_BID_PRC",
      "minBidPrice",
      "minBidPrc",
      "최저입찰가",
      "최저입찰가격",
      "최저가격",
      "BID_MNMT_AMT",
      "bidMnmtAmt",
      "lowstBidPrcIndctCont"
    ]),
    appraisal: firstValue(row, ["APSL_ASES_AVG_AMT", "appraisal", "감정가", "감정평가금액", "apslEvlAmt"]),
    landArea: firstValue(row, ["LAND_AREA", "landArea", "토지면적", "AREA", "area", "landSqms", "bldSqms"]),
    pnu: firstValue(row, ["ltnoPnu", "rdnmPnu"]),
    bidDate: firstValue(row, ["PBCT_CLS_DTM", "pbctClsDtm", "PBCT_BEGN_DTM", "pbctBegnDtm", "입찰일", "cltrBidEndDt"]),
    failCount: firstValue(row, ["usbdNft"]),
    source: "온비드 OpenAPI",
    checks: ["온비드", "권리확인 필요"]
  };
}

function buildOnbidAddress(row) {
  return [row.lctnSdnm, row.lctnSggnm, row.lctnEmdNm].filter(Boolean).join(" ");
}
