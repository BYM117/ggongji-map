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
import { fetchVworldPoint } from "./vworld.mjs";

const DEFAULT_ONBID_API_URL = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2";
const DEFAULT_ONBID_QUERY = "resultType=json&prptDivCd=0007&pvctTrgtYn=N&dspsMthodCd=0001";

const cache = {
  rowsPromise: null,
  rowsKey: "",
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

  const allRows = await getAllOnbidRows(params);
  const roughRows = allRows.filter((row) => isRoughlyInsideBounds(mapOnbidRow(row), bounds));

  const mapped = await mapWithConcurrency(roughRows, 8, hydrateCachedOnbidRow);
  const properties = mapped.map(normalizeProperty).filter(Boolean).filter((item) => isPropertyInsideBounds(item, bounds));
  return {
    ok: true,
    source: "온비드",
    properties,
    diagnostics: {
      source: "onbid",
      scannedRows: allRows.length,
      candidateCount: roughRows.length,
      returnedCount: properties.length
    }
  };
}

async function getAllOnbidRows(params) {
  const cacheKey = [
    params.get("onbidRows") || process.env.ONBID_NUM_OF_ROWS || "100",
    params.get("onbidPages") || process.env.ONBID_VIEWPORT_MAX_PAGES || process.env.ONBID_MAX_PAGES || "10"
  ].join(":");
  if (cache.rowsPromise && cache.rowsKey === cacheKey) return cache.rowsPromise;
  cache.rowsKey = cacheKey;

  cache.rowsPromise = (async () => {
    const numOfRows = clamp(numberFrom(params.get("onbidRows")) || numberFrom(process.env.ONBID_NUM_OF_ROWS) || 100, 1, 100);
    const maxPages = clamp(
      numberFrom(params.get("onbidPages")) ||
        numberFrom(process.env.ONBID_VIEWPORT_MAX_PAGES) ||
        numberFrom(process.env.ONBID_MAX_PAGES) ||
        10,
      1,
      100
    );
    const rows = [];
    let totalCount = 0;

    for (let offset = 0; offset < maxPages; offset += 1) {
      const pageParams = new URLSearchParams(params);
      pageParams.set("pageNo", String(offset + 1));
      pageParams.set("numOfRows", String(numOfRows));

      let result = null;
      try {
        result = await fetchJson(buildOnbidUrl(pageParams));
      } catch {
        break;
      }

      const errorPayload = makeOnbidErrorPayload(result, params);
      if (errorPayload) break;

      const pageRows = extractRows(result);
      rows.push(...pageRows);
      totalCount = totalCount || extractTotalCount(result);

      if (pageRows.length < numOfRows) break;
      if (totalCount && offset + 1 >= Math.ceil(totalCount / numOfRows)) break;
    }

    return rows;
  })();

  return cache.rowsPromise;
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
    if (!["serviceKey", keyParam, "silent", "includeRaw", "maxPages", "maxProperties"].includes(key)) {
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
