import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const host = process.env.HOST || (process.env.VERCEL ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 4173);
const root = resolve(".");
loadDotEnv();

const DEFAULT_ONBID_API_URL = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2";
const DEFAULT_ONBID_QUERY = "resultType=json&prptDivCd=0007&pvctTrgtYn=N&dspsMthodCd=0001";

const cache = {
  courtRowsPromise: null,
  courtRowsKey: "",
  courtSnapshotRowsPromise: null,
  courtProperties: new Map(),
  courtGeocodeMisses: new Set(),
  onbidRowsPromise: null,
  onbidRowsKey: "",
  onbidProperties: new Map()
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

export async function handleApiRequest(request, response) {
  const requestHost = request.headers.host || `${host}:${port}`;
  const url = new URL(request.url || "/", `http://${requestHost}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(url, response);
    return;
  }

  sendJson(response, 404, { ok: false, error: "unknown_api" });
}

const server = createServer(async (request, response) => {
  const requestHost = request.headers.host || `${host}:${port}`;
  const url = new URL(request.url || "/", `http://${requestHost}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(url, response);
    return;
  }

  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = normalize(join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  server.listen(port, host, () => {
    console.log(`http://${host}:${port}`);
  });
}

async function handleApi(url, response) {
  try {
    if (url.pathname === "/api/properties") {
      const payload = await readExternalProperties();
      sendJson(response, 200, payload);
      return;
    }

    if (url.pathname === "/api/land-price") {
      const payload = await fetchLandPrice(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/parcel-boundary") {
      const payload = await fetchParcelBoundary(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/seoul-deals") {
      const payload = await fetchSeoulDeals(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/onbid-properties") {
      const payload = await fetchOnbidProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/court-auctions") {
      const payload = await fetchCourtAuctionProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/viewport-properties") {
      const payload = await fetchViewportProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/onbid") {
      const payload = await fetchOnbid(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    sendJson(response, 404, { ok: false, error: "unknown_api" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: "server_error", message: error.message });
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readExternalProperties() {
  const sources = [];
  const jsonProperties = await readPropertiesJson();
  const onbidProperties = await readPropertiesCsv("data/onbid.csv", "온비드 CSV");
  const courtProperties = await readPropertiesCsv("data/court-auction.csv", "대법원경매 CSV");
  const liveCourtAuctions = await fetchCourtAuctionProperties(new URLSearchParams({ silent: "1", exactGeocode: "1" }));
  const liveCourtAuctionProperties = liveCourtAuctions.ok ? liveCourtAuctions.properties : [];
  const liveOnbid = await fetchOnbidProperties(new URLSearchParams({ silent: "1" }));
  const liveOnbidProperties = liveOnbid.ok ? liveOnbid.properties : [];
  const properties = [...jsonProperties, ...onbidProperties, ...courtProperties, ...liveCourtAuctionProperties, ...liveOnbidProperties]
    .map(normalizeProperty)
    .filter(Boolean);

  if (jsonProperties.length) sources.push("data/properties.json");
  if (onbidProperties.length) sources.push("data/onbid.csv");
  if (courtProperties.length) sources.push("data/court-auction.csv");
  if (liveCourtAuctionProperties.length) sources.push("법원경매 API");
  if (liveOnbidProperties.length) sources.push("온비드 OpenAPI");

  return {
    ok: true,
    source: sources.length ? sources.join(", ") : "empty",
    properties,
    diagnostics: {
      onbid: {
        configured: Boolean(onbidEndpoint() && process.env.ONBID_SERVICE_KEY),
        fetched: liveOnbid.rawCount || 0,
        mapped: liveOnbid.mappedCount || 0,
        dropped: liveOnbid.droppedCount || 0,
        message: liveOnbid.ok ? liveOnbid.message : liveOnbid.message || null
      },
      courtAuction: {
        configured: Boolean(process.env.COURT_AUCTION_API_URL || process.env.COURT_AUCTION_API_BASE_URL),
        fetched: liveCourtAuctions.rawCount || 0,
        mapped: liveCourtAuctions.mappedCount || 0,
        dropped: liveCourtAuctions.droppedCount || 0,
        message: liveCourtAuctions.ok ? liveCourtAuctions.message : liveCourtAuctions.message || null
      }
    }
  };
}

async function readPropertiesJson() {
  const path = join(root, "data/properties.json");
  if (!(await exists(path))) return [];
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.properties || [];
}

async function readPropertiesCsv(pathFromRoot, sourceName) {
  const path = join(root, pathFromRoot);
  if (!(await exists(path))) return [];
  const rows = parseCsv(await readFile(path, "utf8"));
  return rows.map((row) => ({ ...row, source: row.source || sourceName }));
}

function normalizeProperty(raw) {
  const lat = numberFrom(firstValue(raw, ["lat", "latitude", "y", "위도", "LAT", "LATITUDE", "yCrdnt", "Y_CRDNT"]));
  const lng = numberFrom(firstValue(raw, ["lng", "longitude", "x", "경도", "LNG", "LON", "LONGITUDE", "xCrdnt", "X_CRDNT"]));
  const minBid = numberFrom(
    firstValue(raw, [
      "minBid",
      "min_bid",
      "lowestBid",
      "bidPrice",
      "minBidPrice",
      "minBidPrc",
      "MIN_BID_PRICE",
      "MIN_BID_PRC",
      "최저입찰가",
      "최저입찰가격",
      "최저매각가격",
      "최저가격",
      "입찰최저가"
    ])
  );
  const landArea = numberFrom(firstValue(raw, ["landArea", "land_area", "area", "토지면적", "LAND_AREA", "ldArea", "bldArea"]));
  const address = String(firstValue(raw, ["address", "addr", "주소", "소재지", "물건소재지", "GOODS_LCTN_ADDR", "goodsLctnAddr"]) || "");

  if (!lat || !lng || !minBid) return null;

  return {
    id: String(firstValue(raw, ["id", "caseNo", "case_no", "itemNo", "물건번호", "PLNM_NO", "pbctNo"]) || `property-${lat}-${lng}-${minBid}`),
    caseNo: String(firstValue(raw, ["caseNo", "case_no", "itemNo", "사건번호", "물건번호", "PLNM_NO", "pbctNo"]) || "실데이터"),
    title: String(firstValue(raw, ["title", "name", "물건명", "물건이름", "GOODS_NM", "goodsNm"]) || address || "경공매 물건"),
    type: inferPropertyType(firstValue(raw, ["type", "category", "물건유형", "용도", "CTGR_FULL_NM", "goodsKndNm", "usage"]) || ""),
    region: String(firstValue(raw, ["region", "지역"]) || guessRegion(address)),
    address,
    lat,
    lng,
    minBid,
    appraisal: numberFrom(firstValue(raw, ["appraisal", "appraisalPrice", "감정가", "감정평가금액", "APSL_ASES_AVG_AMT"])) || minBid,
    publicLandPricePerSqm: numberFrom(firstValue(raw, ["publicLandPricePerSqm", "officialLandPrice", "공시지가"])) || 0,
    landArea: landArea || 1,
    publicHousingPrice: numberFrom(firstValue(raw, ["publicHousingPrice", "공동주택공시가격"])) || null,
    pnu: firstValue(raw, ["pnu", "PNU", "PNU_CD", "ltnoPnu", "rdnmPnu"]) || "",
    bidDate: normalizeDate(firstValue(raw, ["bidDate", "bid_date", "입찰일", "PBCT_BEGN_DTM", "PBCT_CLS_DTM", "cltrBidPeriod"]) || ""),
    failCount: numberFrom(firstValue(raw, ["failCount", "fail_count", "유찰횟수", "유찰수"])) || 0,
    risk: String(firstValue(raw, ["risk", "위험도"]) || "보통"),
    memo: String(firstValue(raw, ["memo", "메모", "비고"]) || "실데이터 반입 물건입니다. 권리관계와 현장 확인이 필요합니다."),
    zoning: String(firstValue(raw, ["zoning", "용도지역", "landUse"]) || "확인 필요"),
    source: String(raw.source || "실데이터"),
    nearbyDeals: normalizeDeals(raw.nearbyDeals),
    checks: normalizeChecks(raw.checks)
  };
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && String(object[key]).trim() !== "") {
      return object[key];
    }
  }
  return "";
}

function inferPropertyType(value) {
  const text = String(value || "");
  if (text.includes("오피스텔")) return "오피스텔";
  if (text.includes("아파트")) return "아파트";
  if (text.includes("연립") || text.includes("다세대") || text.includes("빌라") || text.includes("주거용건물")) return "빌라";
  if (text.includes("상가") || text.includes("업무용") || text.includes("근린")) return "상가";
  if (text.includes("임야")) return "토지";
  if (text.includes("토지") || text.includes("대지") || text.includes("전") || text.includes("답")) return "토지";
  return text || "토지";
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{8,14}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}\.\d{1,2}\.\d{1,2}/.test(text)) {
    const [year, month, day] = text.split(/[.\s]/).filter(Boolean);
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(text)) {
    const [year, month, day] = text.split(/[\/\s]/).filter(Boolean);
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function normalizeDeals(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function normalizeChecks(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split("|").map((item) => item.trim());
  return ["실데이터", "권리확인 필요"];
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

async function fetchLandPrice(params) {
  const pnu = params.get("pnu");
  const requestedYear = numberFrom(params.get("year")) || new Date().getFullYear();
  const serviceKey = process.env.VWORLD_API_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  const domain = vworldDomain();

  if (!pnu) return { ok: false, error: "missing_pnu" };
  if (!serviceKey) {
    return {
      ok: false,
      error: "missing_key",
      message: ".env에 VWORLD_API_KEY를 넣으면 개별공시지가 API를 호출합니다."
    };
  }

  const years = [requestedYear, requestedYear - 1, requestedYear - 2]
    .filter((value, index, array) => value > 2000 && array.indexOf(value) === index)
    .map(String);

  let result = null;
  let first = null;
  let matchedYear = years[0];

  for (const year of years) {
    result = await fetchLandPriceYear({ pnu, year, serviceKey, domain });
    first = result?.indvdLandPrices?.field?.[0] || null;
    matchedYear = year;
    if (first) break;
  }

  return {
    ok: true,
    source: "개별공시지가속성조회",
    pnu,
    year: matchedYear,
    requestedYear: String(requestedYear),
    pricePerSqm: first ? numberFrom(first.pblntfPclnd) : null,
    publishedAt: first?.pblntfDe || null,
    landCodeName: first?.ldCodeNm || null,
    raw: result
  };
}

async function fetchLandPriceYear({ pnu, year, serviceKey, domain }) {
  const apiUrl = new URL("https://api.vworld.kr/ned/data/getIndvdLandPriceAttr");
  apiUrl.searchParams.set("key", serviceKey);
  apiUrl.searchParams.set("pnu", pnu);
  apiUrl.searchParams.set("stdrYear", year);
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("numOfRows", "10");
  apiUrl.searchParams.set("pageNo", "1");
  apiUrl.searchParams.set("domain", domain);

  return fetchJson(apiUrl);
}

async function fetchParcelBoundary(params) {
  const pnu = params.get("pnu");
  const serviceKey = process.env.VWORLD_API_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  const domain = vworldDomain();

  if (!pnu) return { ok: false, error: "missing_pnu" };
  if (!serviceKey) {
    return {
      ok: false,
      error: "missing_key",
      message: ".env에 VWORLD_API_KEY를 넣으면 필지 경계 API를 호출합니다."
    };
  }

  const apiUrl = new URL("https://api.vworld.kr/req/data");
  apiUrl.searchParams.set("service", "data");
  apiUrl.searchParams.set("version", "2.0");
  apiUrl.searchParams.set("request", "GetFeature");
  apiUrl.searchParams.set("key", serviceKey);
  apiUrl.searchParams.set("domain", domain);
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("size", "10");
  apiUrl.searchParams.set("page", "1");
  apiUrl.searchParams.set("data", "LP_PA_CBND_BUBUN");
  apiUrl.searchParams.set("attrFilter", `pnu:=:${pnu}`);

  const result = await fetchJson(apiUrl);
  const response = result?.response;
  const featureCollection = response?.result?.featureCollection || null;
  const features = featureCollection?.features || [];

  if (response?.status && response.status !== "OK") {
    return {
      ok: false,
      error: "parcel_boundary_error",
      message: response?.error?.text || "필지 경계 응답 오류입니다.",
      raw: result
    };
  }

  return {
    ok: true,
    source: "연속지적도",
    pnu,
    count: features.length,
    featureCollection,
    properties: features[0]?.properties || null
  };
}

async function fetchSeoulDeals(params) {
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

async function fetchOnbid(params) {
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

async function fetchOnbidProperties(params) {
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

async function fetchViewportProperties(params) {
  const bounds = parseViewportBounds(params);
  if (!bounds) {
    return {
      ok: false,
      error: "missing_bounds",
      message: "swLat, swLng, neLat, neLng가 필요합니다.",
      properties: []
    };
  }

  const sources = String(params.get("sources") || "court,onbid")
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);
  const includeCourt = sources.includes("court") || sources.includes("all");
  const includeOnbid = sources.includes("onbid") || sources.includes("all");
  const exactGeocode = params.get("exactGeocode") !== "0";
  const payloads = [];

  if (includeCourt) {
    payloads.push(fetchCourtAuctionViewportProperties(params, bounds, { exactGeocode }));
  }
  if (includeOnbid) {
    payloads.push(fetchOnbidViewportProperties(params, bounds));
  }

  const results = await Promise.all(payloads);
  const properties = uniqueProperties(results.flatMap((result) => (result.ok ? result.properties : [])))
    .sort((a, b) => compareViewportProperties(a, b));

  return {
    ok: true,
    source: results.filter((result) => result.ok && result.properties.length).map((result) => result.source).join(", ") || "empty",
    message: properties.length ? "현재 지도 화면 안의 경공매 물건을 반환했습니다." : "현재 지도 화면 안에 표시할 물건이 없습니다.",
    properties,
    diagnostics: {
      bounds,
      sources,
      totalCandidateCount: results.reduce((sum, result) => sum + (result.diagnostics?.candidateCount || 0), 0),
      returnedCount: properties.length,
      details: results.map((result) => result.diagnostics || {})
    }
  };
}

async function fetchCourtAuctionViewportProperties(params, bounds, { exactGeocode = true } = {}) {
  const allRows = await getAllCourtAuctionRows(params);
  const roughRows = allRows.filter((row) => isRoughlyInsideBounds(row, bounds));
  const shouldProxyGeocode = process.env.COURT_AUCTION_ENABLE_PROXY_GEOCODE === "1" && exactGeocode;
  const mapped = shouldProxyGeocode
    ? await mapWithConcurrency(roughRows, 8, (row) => hydrateCachedCourtAuctionRow(row, { exactGeocode }))
    : roughRows.map(mapCourtAuctionRow);
  const properties = mapped.map(normalizeProperty).filter(Boolean).filter((item) => isPropertyInsideBounds(item, bounds));

  return {
    ok: true,
    source: "법원경매",
    properties,
    diagnostics: {
      source: "court",
      scannedRows: allRows.length,
      candidateCount: roughRows.length,
      returnedCount: properties.length
    }
  };
}

async function fetchOnbidViewportProperties(params, bounds) {
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
  if (cache.onbidRowsPromise && cache.onbidRowsKey === cacheKey) return cache.onbidRowsPromise;
  cache.onbidRowsKey = cacheKey;

  cache.onbidRowsPromise = (async () => {
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

  return cache.onbidRowsPromise;
}

async function getAllCourtAuctionRows(params) {
  const cacheKey = [
    params.get("swLat") || "",
    params.get("swLng") || "",
    params.get("neLat") || "",
    params.get("neLng") || "",
    params.get("active") || process.env.COURT_AUCTION_ACTIVE || "true",
    params.get("sort") || process.env.COURT_AUCTION_SORT || "priority_desc",
    params.get("courtRows") || "500",
    params.get("courtPages") || "50"
  ].join(":");
  if (cache.courtRowsPromise && cache.courtRowsKey === cacheKey) return cache.courtRowsPromise;
  cache.courtRowsKey = cacheKey;

  cache.courtRowsPromise = (async () => {
    const baseUrl = courtAuctionBaseUrl();
    if (!baseUrl) {
      return getCourtAuctionSnapshotRows();
    }

    const scanLimit = clamp(numberFrom(params.get("courtRows")) || 500, 50, 500);
    const maxScanPages = clamp(numberFrom(params.get("courtPages")) || 50, 1, 100);
    const rows = [];
    let total = 0;

    for (let pageIndex = 0; pageIndex < maxScanPages; pageIndex += 1) {
      const pageOffset = pageIndex * scanLimit;
      const pageResult = await fetchJson(buildCourtAuctionUrl(params, { limit: scanLimit, offset: pageOffset }));
      if (pageResult?.error) break;

      const pageRows = Array.isArray(pageResult?.items) ? pageResult.items : [];
      rows.push(...pageRows);
      total = total || numberFrom(pageResult?.total);

      if (pageRows.length < scanLimit) break;
      if (total && rows.length >= total) break;
    }

    return rows;
  })();

  return cache.courtRowsPromise;
}

async function getCourtAuctionSnapshotRows() {
  if (cache.courtSnapshotRowsPromise) return cache.courtSnapshotRowsPromise;
  cache.courtSnapshotRowsPromise = (async () => {
    const snapshotPath = resolve(process.env.COURT_AUCTION_SNAPSHOT_PATH || join(root, "data/court-auctions.snapshot.json"));
    try {
      const payload = JSON.parse(await readFile(snapshotPath, "utf8"));
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload.items)) return payload.items;
      return [];
    } catch {
      return [];
    }
  })();
  return cache.courtSnapshotRowsPromise;
}

async function hydrateCachedCourtAuctionRow(row, options) {
  const mapped = mapCourtAuctionRow(row);
  const cached = cache.courtProperties.get(mapped.id);
  if (cached && hasUsableCoordinates(cached)) return cached;
  if (cached && !options?.exactGeocode) return cached;
  if (options?.exactGeocode && cache.courtGeocodeMisses.has(mapped.id)) return cached || mapped;

  const hydrated = await hydrateCourtAuctionRow(mapped, options);
  if (hasUsableCoordinates(hydrated) || !options?.exactGeocode) {
    cache.courtProperties.set(mapped.id, hydrated);
  } else if (options?.exactGeocode) {
    cache.courtGeocodeMisses.add(mapped.id);
  }
  return hydrated;
}

function hasUsableCoordinates(value) {
  return Boolean(
    numberFrom(firstValue(value, ["lat", "latitude", "y"])) &&
    numberFrom(firstValue(value, ["lng", "longitude", "x"]))
  );
}

async function hydrateCachedOnbidRow(row) {
  const mapped = mapOnbidRow(row);
  const cacheKey = mapped.id || `${mapped.caseNo}:${mapped.address}`;
  if (cache.onbidProperties.has(cacheKey)) return cache.onbidProperties.get(cacheKey);

  const hydrated = await hydrateOnbidRow(mapped);
  cache.onbidProperties.set(cacheKey, hydrated);
  return hydrated;
}

function parseViewportBounds(params) {
  const swLat = numberFrom(params.get("swLat"));
  const swLng = numberFrom(params.get("swLng"));
  const neLat = numberFrom(params.get("neLat"));
  const neLng = numberFrom(params.get("neLng"));
  if (!swLat || !swLng || !neLat || !neLng) return null;

  return {
    swLat: Math.min(swLat, neLat),
    swLng: Math.min(swLng, neLng),
    neLat: Math.max(swLat, neLat),
    neLng: Math.max(swLng, neLng)
  };
}

function isRoughlyInsideBounds(row, bounds) {
  const lat = numberFrom(firstValue(row, ["lat", "latitude", "y"]));
  const lng = numberFrom(firstValue(row, ["lng", "longitude", "x"]));
  const roughText = row?.address || row?.addr || row?.court || row?.court_name || courtAuctionSearchText(row);
  const point = lat && lng ? { lat, lng } : roughPointForAddress(roughText);
  if (!point) return false;

  const latSpan = Math.max(bounds.neLat - bounds.swLat, 0.02);
  const lngSpan = Math.max(bounds.neLng - bounds.swLng, 0.02);
  const buffer = Math.max(0.12, Math.min(1.2, Math.max(latSpan, lngSpan) * 1.4));
  return (
    point.lat >= bounds.swLat - buffer &&
    point.lat <= bounds.neLat + buffer &&
    point.lng >= bounds.swLng - buffer &&
    point.lng <= bounds.neLng + buffer
  );
}

function roughPointForAddress(value) {
  const text = cleanAuctionAddress(value);
  const provinceCenters = [
    ["서울특별시", 37.5665, 126.9780],
    ["서울", 37.5665, 126.9780],
    ["경기도", 37.4138, 127.5183],
    ["경기", 37.4138, 127.5183],
    ["인천광역시", 37.4563, 126.7052],
    ["인천", 37.4563, 126.7052],
    ["부산", 35.1796, 129.0756],
    ["대구", 35.8714, 128.6014],
    ["대전", 36.3504, 127.3845],
    ["광주광역시", 35.1595, 126.8526],
    ["울산", 35.5384, 129.3114],
    ["세종", 36.4800, 127.2890],
    ["강원", 37.8228, 128.1555],
    ["충청북도", 36.8000, 127.7000],
    ["충북", 36.8000, 127.7000],
    ["충청남도", 36.5184, 126.8000],
    ["충남", 36.5184, 126.8000],
    ["전북", 35.7175, 127.1530],
    ["전라북도", 35.7175, 127.1530],
    ["전남", 34.8679, 126.9910],
    ["전라남도", 34.8679, 126.9910],
    ["경북", 36.4919, 128.8889],
    ["경상북도", 36.4919, 128.8889],
    ["경남", 35.4606, 128.2132],
    ["경상남도", 35.4606, 128.2132],
    ["제주", 33.4996, 126.5312]
  ];
  const startsInMetro = /^(서울|서울특별시|경기|경기도|인천|인천광역시)(\s|$)/.test(text);
  const province = provinceCenters.find(([name]) => text.startsWith(name));
  if (province && !startsInMetro) return { lat: province[1], lng: province[2] };

  const centers = [
    ["강남", 37.5172, 127.0473],
    ["서초", 37.4837, 127.0324],
    ["송파", 37.5145, 127.1059],
    ["강동", 37.5301, 127.1238],
    ["마포", 37.5663, 126.9019],
    ["용산", 37.5326, 126.9900],
    ["영등포", 37.5264, 126.8962],
    ["구로", 37.4955, 126.8877],
    ["금천", 37.4569, 126.8955],
    ["관악", 37.4784, 126.9516],
    ["동작", 37.5124, 126.9393],
    ["성동", 37.5634, 127.0369],
    ["광진", 37.5384, 127.0822],
    ["중랑", 37.6063, 127.0925],
    ["노원", 37.6542, 127.0568],
    ["도봉", 37.6688, 127.0471],
    ["강북", 37.6396, 127.0257],
    ["성북", 37.5894, 127.0167],
    ["은평", 37.6176, 126.9227],
    ["서대문", 37.5791, 126.9368],
    ["종로", 37.5735, 126.9788],
    ["중구", 37.5636, 126.9976],
    ["동대문", 37.5744, 127.0396],
    ["양천", 37.5169, 126.8665],
    ["강서", 37.5509, 126.8495],
    ["수원", 37.2636, 127.0286],
    ["성남", 37.4200, 127.1265],
    ["고양", 37.6584, 126.8320],
    ["용인", 37.2411, 127.1776],
    ["부천", 37.5034, 126.7660],
    ["안산", 37.3219, 126.8309],
    ["안양", 37.3943, 126.9568],
    ["남양주", 37.6360, 127.2165],
    ["화성", 37.1995, 126.8312],
    ["평택", 36.9921, 127.1127],
    ["의정부", 37.7381, 127.0337],
    ["시흥", 37.3802, 126.8029],
    ["파주", 37.7599, 126.7799],
    ["김포", 37.6153, 126.7156],
    ["광명", 37.4786, 126.8646],
    ["광주", 37.4294, 127.2550],
    ["군포", 37.3617, 126.9352],
    ["하남", 37.5393, 127.2148],
    ["오산", 37.1498, 127.0772],
    ["이천", 37.2723, 127.4350],
    ["안성", 37.0080, 127.2797],
    ["의왕", 37.3447, 126.9683],
    ["양주", 37.7853, 127.0458],
    ["구리", 37.5943, 127.1296],
    ["포천", 37.8949, 127.2003],
    ["여주", 37.2983, 127.6371],
    ["동두천", 37.9037, 127.0606],
    ["과천", 37.4292, 126.9877],
    ["인천", 37.4563, 126.7052],
    ["서울", 37.5665, 126.9780],
    ["경기도", 37.4138, 127.5183],
    ["경기", 37.4138, 127.5183],
    ["부산", 35.1796, 129.0756],
    ["대구", 35.8714, 128.6014],
    ["대전", 36.3504, 127.3845],
    ["광주광역시", 35.1595, 126.8526],
    ["울산", 35.5384, 129.3114],
    ["세종", 36.4800, 127.2890],
    ["강원", 37.8228, 128.1555],
    ["충북", 36.8000, 127.7000],
    ["충남", 36.5184, 126.8000],
    ["전북", 35.7175, 127.1530],
    ["전남", 34.8679, 126.9910],
    ["경북", 36.4919, 128.8889],
    ["경남", 35.4606, 128.2132],
    ["제주", 33.4996, 126.5312]
  ];
  const picked = centers.find(([name]) => matchesAdminName(text, name));
  return picked ? { lat: picked[1], lng: picked[2] } : null;
}

function matchesAdminName(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/[시군구]$/.test(name)) {
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(text);
  }
  return new RegExp(`(^|\\s)${escaped}(시|군|구|\\s|$)`).test(text);
}

function isPropertyInsideBounds(item, bounds) {
  return item.lat >= bounds.swLat && item.lat <= bounds.neLat && item.lng >= bounds.swLng && item.lng <= bounds.neLng;
}

function uniqueProperties(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function compareViewportProperties(a, b) {
  if (a.source !== b.source) return sourceWeight(a.source) - sourceWeight(b.source);
  return new Date(a.bidDate) - new Date(b.bidDate);
}

function sourceWeight(source) {
  return String(source || "").includes("법원") ? 0 : 1;
}

async function fetchCourtAuctionProperties(params) {
  const pageNo = Math.max(numberFrom(params.get("pageNo")) || 1, 1);
  const limit = clamp(
    numberFrom(params.get("limit")) || numberFrom(params.get("numOfRows")) || numberFrom(process.env.COURT_AUCTION_NUM_OF_ROWS) || 100,
    1,
    500
  );
  const offset = Math.max(numberFrom(params.get("offset")) || (pageNo - 1) * limit, 0);
  const maxProperties = clamp(numberFrom(params.get("maxProperties")) || limit, 1, 500);
  const regionGroup = params.get("regionGroup") || params.get("region_group") || "";
  const isMetroGroup = ["metro", "capital", "수도권"].includes(regionGroup.trim().toLowerCase()) || params.get("metro") === "1";

  let result = null;
  let rows = [];
  let scannedRows = 0;
  let scanPages = 0;

  try {
    if (isMetroGroup) {
      const collected = [];
      const scanLimit = clamp(numberFrom(params.get("scanLimit")) || 500, 50, 500);
      const maxScanPages = clamp(numberFrom(params.get("scanPages")) || 12, 1, 20);
      const wantedCount = offset + maxProperties;

      for (let pageIndex = 0; pageIndex < maxScanPages && collected.length < wantedCount; pageIndex += 1) {
        const pageOffset = pageIndex * scanLimit;
        const pageResult = await fetchJson(buildCourtAuctionUrl(params, { limit: scanLimit, offset: pageOffset }));
        if (!result) result = pageResult;
        if (pageResult?.error) {
          result = pageResult;
          break;
        }

        const pageRows = Array.isArray(pageResult?.items) ? pageResult.items : [];
        scannedRows += pageRows.length;
        scanPages += 1;
        collected.push(...pageRows.filter(isMetroCourtAuctionRow));

        if (pageRows.length < scanLimit) break;
      }

      rows = collected.slice(offset, offset + maxProperties);
    } else {
      result = await fetchJson(buildCourtAuctionUrl(params, { limit, offset }));
      rows = Array.isArray(result?.items) ? result.items.slice(0, maxProperties) : [];
      scannedRows = rows.length;
      scanPages = rows.length ? 1 : 0;
    }
  } catch (error) {
    return {
      ok: false,
      error: "court_auction_api_unavailable",
      message: `법원경매 API 서버에 연결하지 못했습니다. ${courtAuctionBaseUrl()} 서버를 먼저 실행하세요.`,
      rawCount: 0,
      mappedCount: 0,
      droppedCount: 0,
      properties: [],
      raw: params.get("includeRaw") === "1" ? { message: error.message } : undefined
    };
  }

  if (result?.error) {
    return {
      ok: false,
      error: result.error,
      message: "법원경매 API 응답 오류입니다.",
      rawCount: 0,
      mappedCount: 0,
      droppedCount: 0,
      properties: [],
      raw: params.get("includeRaw") === "1" ? result : undefined
    };
  }

  const exactGeocode = params.get("exactGeocode") === "1";
  const mapped = await mapWithConcurrency(rows, 8, (row) => hydrateCourtAuctionRow(mapCourtAuctionRow(row), { exactGeocode }));
  const properties = mapped.map(normalizeProperty).filter(Boolean);

  return {
    ok: true,
    source: "법원경매 API",
    message: rows.length ? "법원경매 API 응답을 꽁지맵 물건으로 정규화했습니다." : "법원경매 API에 표시할 물건이 없습니다.",
    total: numberFrom(result?.total),
    count: numberFrom(result?.count),
    rawCount: rows.length,
    mappedCount: properties.length,
    droppedCount: Math.max(mapped.length - properties.length, 0),
    properties,
    diagnostics: {
      endpoint: courtAuctionBaseUrl(),
      total: numberFrom(result?.total),
      limit,
      offset,
      regionGroup: isMetroGroup ? "metro" : "",
      scannedRows,
      scanPages,
      requiresCoordinates: true,
      exactGeocode
    },
    raw: params.get("includeRaw") === "1" ? result : undefined
  };
}

function isMetroCourtAuctionRow(row) {
  const address = String(row?.address || row?.addr || "").trim();
  if (/^(서울|서울특별시|경기|경기도|인천|인천광역시)(\s|$)/.test(address)) return true;
  if (address) return false;

  return /^(서울|서울중앙|서울동부|서울서부|서울남부|서울북부|인천|수원|성남|고양|의정부|안양|평택|부천|안산|시흥|용인|여주)/.test(
    String(row?.court || row?.court_name || "").trim()
  );
}

function courtAuctionSearchText(row) {
  return [
    row?.address,
    row?.addr,
    row?.court,
    row?.court_name,
    row?.case_no,
    row?.category,
    row?.detail_url
  ]
    .filter(Boolean)
    .join(" ");
}

function buildCourtAuctionUrl(params, { limit, offset }) {
  const baseUrl = courtAuctionBaseUrl();
  if (!baseUrl) throw new Error("COURT_AUCTION_API_URL is not configured");
  const apiUrl = new URL("/api/v1/auctions", baseUrl);
  const passthrough = [
    "q",
    "query",
    "status",
    "source",
    "region",
    "sale_date_from",
    "sale_date_to",
    "active",
    "sort"
  ];

  apiUrl.searchParams.set("limit", String(limit));
  apiUrl.searchParams.set("offset", String(offset));
  apiUrl.searchParams.set("active", params.get("active") || process.env.COURT_AUCTION_ACTIVE || "true");
  apiUrl.searchParams.set("sort", params.get("sort") || process.env.COURT_AUCTION_SORT || "priority_desc");
  apiUrl.searchParams.set("require_coordinates", params.get("require_coordinates") || "1");

  for (const key of ["swLat", "swLng", "neLat", "neLng"]) {
    const value = params.get(key);
    if (value) apiUrl.searchParams.set(key, value);
  }

  for (const key of passthrough) {
    const value = params.get(key);
    if (value && !apiUrl.searchParams.has(key)) apiUrl.searchParams.set(key, value);
  }

  for (const [key, value] of parseQueryString(process.env.COURT_AUCTION_DEFAULT_QUERY || "").entries()) {
    if (!apiUrl.searchParams.has(key)) apiUrl.searchParams.set(key, value);
  }

  return apiUrl;
}

function courtAuctionBaseUrl() {
  if (process.env.COURT_AUCTION_USE_SNAPSHOT === "1") return "";
  const configured = process.env.COURT_AUCTION_API_URL || process.env.COURT_AUCTION_API_BASE_URL;
  if (configured) return String(configured).replace(/\/$/, "");
  return process.env.VERCEL ? "" : "http://127.0.0.1:8000";
}

async function hydrateCourtAuctionRow(row, { exactGeocode = true } = {}) {
  if (numberFrom(firstValue(row, ["lat", "latitude", "y"])) && numberFrom(firstValue(row, ["lng", "longitude", "x"]))) {
    return row;
  }

  const point = exactGeocode ? await fetchVworldPoint(cleanGeocodeAddress(row.address || row.title)) : null;
  if (!point) {
    return row;
  }

  return {
    ...row,
    lat: point.lat,
    lng: point.lng,
    pnu: point.pnu || row.pnu,
    geocodeSource: "주소 좌표 확인",
    checks: uniqueValues([...(row.checks || []), "주소 좌표 확인"])
  };
}

function mapCourtAuctionRow(row) {
  const normalizedProperty = row.property || {};
  const normalizedAddress = normalizedProperty.address || {};
  const normalizedAuction = row.auction || {};
  const normalizedPrice = row.price || {};
  const normalizedCase = row.case || {};
  const normalizedScreening = row.screening || {};
  const normalizedShare = normalizedProperty.share || {};
  const normalizedArea = normalizedProperty.area || {};
  const address = cleanAuctionAddress(normalizedAddress.raw || row.address || "");
  const cleanAddress = cleanAuctionAddress(normalizedAddress.clean || row.address || "");
  const status = normalizedAuction.status || row.status || "";
  const source = "법원경매";
  const caseNo = normalizedCase.display_case_no || row.case_no || row.caseNo || "";
  const itemNo = normalizedCase.item_no || row.item_no || row.itemNo || "";
  const category = normalizedProperty.category || row.category || "";
  const checks = ["법원경매 API"];
  if (normalizedShare.is_share_sale) checks.push("지분 매각");
  if (normalizedAddress.clean) checks.push("주소 정규화");
  if (normalizedScreening.flags?.length) checks.push(...normalizedScreening.flags.slice(0, 4));

  return {
    ...row,
    id: row.id || [source, caseNo, itemNo].filter(Boolean).join(":"),
    caseNo: [caseNo, itemNo ? `물건 ${itemNo}` : ""].filter(Boolean).join(" · ") || "법원경매",
    title: category ? `${category} 경매물건` : "법원경매 물건",
    type: normalizedProperty.type_guess || inferPropertyType(category || address),
    region: guessRegion(cleanAddress || address || row.court || ""),
    address: cleanAddress || address,
    rawAddress: address,
    minBid: normalizedPrice.minimum_bid || firstMoneyValue(row.minimum_bid || row.minBid || ""),
    appraisal: normalizedPrice.appraisal || firstMoneyValue(row.appraisal || ""),
    landArea: normalizedArea.land_sqm || normalizedArea.total_sqm || extractAreaFromText(address) || 1,
    buildingArea: normalizedArea.building_sqm || null,
    pnu: row.pnu || "",
    bidDate: normalizedAuction.sale_date || row.sale_date || row.saleDate || "",
    failCount: normalizedAuction.fail_count ?? extractFailCount(status),
    risk: normalizedScreening.risk_level || inferCourtRisk(status),
    memo: [
      normalizedCase.court || row.court,
      status,
      normalizedPrice.minimum_bid_percent ? `최저가율 ${normalizedPrice.minimum_bid_percent}%` : "",
      normalizedShare.is_share_sale ? "지분 매각 의심" : "",
      row.detail_url ? `원문: ${row.detail_url}` : ""
    ].filter(Boolean).join(" · "),
    zoning: category || "확인 필요",
    source,
    checks: uniqueValues(checks)
  };
}

function cleanAuctionAddress(value) {
  return String(value || "")
    .replace(/^\s*(사용본거지|소재지|물건소재지)\s*:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFailCount(value) {
  const match = String(value || "").match(/유찰\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

function inferCourtRisk(status) {
  const failCount = extractFailCount(status);
  if (failCount >= 4) return "높음";
  if (failCount >= 2) return "보통";
  return "낮음";
}

function extractAreaFromText(value) {
  const match = String(value || "").match(/([\d,.]+)\s*㎡/);
  return match ? numberFrom(match[1]) : 0;
}

function fallbackPointForAddress(value) {
  const text = String(value || "");
  const rough = roughPointForAddress(text);
  if (rough) {
    const seed = stableNumber(text);
    return {
      lat: rough.lat + ((seed % 1000) / 1000 - 0.5) * 0.018,
      lng: rough.lng + ((Math.floor(seed / 1000) % 1000) / 1000 - 0.5) * 0.018
    };
  }

  const centers = [
    ["서울", 37.5665, 126.9780],
    ["경기", 37.4138, 127.5183],
    ["수원", 37.2636, 127.0286],
    ["성남", 37.4200, 127.1265],
    ["안양", 37.3943, 126.9568],
    ["평택", 36.9921, 127.1127],
    ["고양", 37.6584, 126.8320],
    ["의정부", 37.7381, 127.0337],
    ["인천", 37.4563, 126.7052],
    ["부산", 35.1796, 129.0756],
    ["대구", 35.8714, 128.6014],
    ["광주", 35.1595, 126.8526],
    ["대전", 36.3504, 127.3845],
    ["울산", 35.5384, 129.3114],
    ["세종", 36.4800, 127.2890],
    ["강원", 37.8228, 128.1555],
    ["청주", 36.6424, 127.4890],
    ["충북", 36.8000, 127.7000],
    ["천안", 36.8151, 127.1139],
    ["충남", 36.5184, 126.8000],
    ["전주", 35.8242, 127.1480],
    ["전북", 35.7175, 127.1530],
    ["목포", 34.8118, 126.3922],
    ["순천", 34.9506, 127.4875],
    ["전남", 34.8679, 126.9910],
    ["포항", 36.0190, 129.3435],
    ["경북", 36.4919, 128.8889],
    ["창원", 35.2285, 128.6811],
    ["경남", 35.4606, 128.2132],
    ["제주", 33.4996, 126.5312]
  ];
  const picked = centers.find(([name]) => text.includes(name)) || ["전국", 36.5, 127.8];
  const seed = stableNumber(text);
  return {
    lat: picked[1] + ((seed % 1000) / 1000 - 0.5) * 0.12,
    lng: picked[2] + ((Math.floor(seed / 1000) % 1000) / 1000 - 0.5) * 0.12
  };
}

function stableNumber(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function firstMoneyValue(value) {
  const match = String(value || "").match(/[\d,]+/);
  return match ? match[0] : "";
}

function cleanGeocodeAddress(value) {
  return String(value || "")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*구조[^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeOnbidErrorPayload(result, params) {
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

async function fetchVworldPoint(address) {
  const key = process.env.VWORLD_API_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  if (!key || !address) return null;

  const queries = uniqueValues([address, simplifyAddressForSearch(address)]);
  const categories = ["PARCEL", "ROAD"];

  for (const query of queries) {
    for (const category of categories) {
      const item = await fetchVworldAddressItem({ key, query, category });
      const point = item?.point;
      if (!point?.x || !point?.y) continue;

      return {
        lat: numberFrom(point.y),
        lng: numberFrom(point.x),
        pnu: /^\d{19}$/.test(String(item?.id || "")) ? String(item.id) : "",
        geocodeCategory: category
      };
    }
  }

  return null;
}

async function fetchVworldAddressItem({ key, query, category }) {
  const apiUrl = new URL("https://api.vworld.kr/req/search");
  apiUrl.searchParams.set("service", "search");
  apiUrl.searchParams.set("request", "search");
  apiUrl.searchParams.set("version", "2.0");
  apiUrl.searchParams.set("crs", "EPSG:4326");
  apiUrl.searchParams.set("size", "1");
  apiUrl.searchParams.set("page", "1");
  apiUrl.searchParams.set("type", "ADDRESS");
  apiUrl.searchParams.set("category", category);
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("key", key);
  const domain = vworldDomain();
  if (domain) apiUrl.searchParams.set("domain", domain);

  try {
    const result = await fetchJson(apiUrl);
    return result?.response?.result?.items?.[0] || null;
  } catch {
    return null;
  }
}

function simplifyAddressForSearch(value) {
  return String(value || "")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b제?\d+\s*층\s*제?\d+\s*호\b/g, " ")
    .replace(/\b\d+\s*층\s*\d+\s*호\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function parseQueryString(value) {
  const params = new URLSearchParams();
  String(value || "")
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .forEach((pair) => {
      const [key, ...rest] = pair.split("=");
      if (key) params.set(decodeURIComponent(key), decodeURIComponent(rest.join("=") || ""));
    });
  return params;
}

function onbidEndpoint() {
  return process.env.ONBID_API_URL || DEFAULT_ONBID_API_URL;
}

function vworldDomain() {
  if (process.env.VWORLD_API_DOMAIN) return process.env.VWORLD_API_DOMAIN;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.VERCEL ? "" : "http://127.0.0.1:4173";
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

  return {
    ...row,
    id: firstValue(row, ["id", "cltrMngNo", "CLTR_MNG_NO", "onbidCltrno", "PLNM_NO", "plnmNo", "PBCT_NO", "pbctNo", "CLTR_NO", "cltrNo"]) || "",
    caseNo: firstValue(row, ["cltrMngNo", "CLTR_MNG_NO", "onbidCltrno", "PLNM_NO", "plnmNo", "PBCT_NO", "pbctNo", "CLTR_NO", "cltrNo", "물건번호"]) || "온비드",
    title,
    type: inferPropertyType(category || title),
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

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    results.push(...(await Promise.all(chunk.map(mapper))));
  }
  return results;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return rows;
  const headers = splitCsvLine(lines[0]);

  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];
    if (char === "\"" && inQuotes && nextChar === "\"") {
      value += "\"";
      index += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value.trim());
  return values;
}

function numberFrom(value) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return 0;
  const normalized = String(value).replace(/[^0-9.-]/g, "");
  return Number(normalized) || 0;
}

function cleanText(value) {
  return String(value || "").trim();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function guessRegion(address) {
  return String(address).split(" ").slice(0, 2).join(" ") || "지역 미상";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function loadDotEnv() {
  const path = join(root, ".env");
  try {
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
        const [key, ...rest] = trimmed.split("=");
        if (!process.env[key]) {
          process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
        }
      });
  } catch {}
}
