import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import {
  addBoundedSet,
  clamp,
  fetchJson,
  firstValue,
  mapWithConcurrency,
  numberFrom,
  parseQueryString,
  putBoundedMap,
  uniqueValues
} from "./util.mjs";
import {
  cleanAuctionAddress,
  guessRegion,
  hasUsableCoordinates,
  isPropertyInsideBounds,
  isRoughlyInsideBounds
} from "./geo.mjs";
import { inferPropertyType, normalizeProperty } from "./normalize.mjs";
import { cleanGeocodeAddress, fetchVworldPoint } from "./vworld.mjs";
import { overlayOfficialPrice } from "./official-prices.mjs";

const root = resolve(".");

const cache = {
  rowsPromise: null,
  rowsKey: "",
  snapshotRowsPromise: null,
  properties: new Map(),
  geocodeMisses: new Set()
};

export async function fetchCourtAuctionProperties(params) {
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
    if (!courtAuctionBaseUrl()) {
      const snapshotRows = await getCourtAuctionSnapshotRows();
      const filteredRows = isMetroGroup ? snapshotRows.filter(isMetroCourtAuctionRow) : snapshotRows;
      result = { total: filteredRows.length, count: Math.min(maxProperties, filteredRows.length - offset) };
      rows = filteredRows.slice(offset, offset + maxProperties);
      scannedRows = filteredRows.length;
      scanPages = filteredRows.length ? 1 : 0;
    } else if (isMetroGroup) {
      const collected = [];
      const scanLimit = clamp(numberFrom(params.get("scanLimit")) || 500, 50, 500);
      const maxScanPages = clamp(numberFrom(params.get("scanPages")) || 12, 1, 20);
      const wantedCount = offset + maxProperties;

      for (let pageIndex = 0; pageIndex < maxScanPages && collected.length < wantedCount; pageIndex += 1) {
        const pageOffset = pageIndex * scanLimit;
        const pageResult = await fetchJson(
          buildCourtAuctionUrl(params, { limit: scanLimit, offset: pageOffset }),
          courtAuctionRequestInit()
        );
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
      result = await fetchJson(buildCourtAuctionUrl(params, { limit, offset }), courtAuctionRequestInit());
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
  rows = rows.filter(isRealEstateRow);
  const mapped = await mapWithConcurrency(rows, 8, (row) => hydrateCourtAuctionRow(mapCourtAuctionRow(row), { exactGeocode }));
  const properties = mapped.map(normalizeProperty).filter(Boolean).map(overlayOfficialPrice);

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
      requiresCoordinates: Boolean(courtAuctionRequireCoordinatesValue(params.get("require_coordinates") ?? process.env.COURT_AUCTION_REQUIRE_COORDINATES ?? "0")),
      exactGeocode
    },
    raw: params.get("includeRaw") === "1" ? result : undefined
  };
}

export async function searchCourtAuctionProperties(params) {
  const query = String(params.get("q") || params.get("query") || "").trim();
  if (query.length < 2 || query.length > 80) {
    return {
      ok: false,
      error: "invalid_search_query",
      message: "검색어는 2자 이상 80자 이하로 입력해 주세요.",
      properties: []
    };
  }

  const limit = clamp(numberFrom(params.get("limit")) || 20, 1, 20);
  const normalizedQuery = normalizeCourtSearchValue(query);
  const allParams = new URLSearchParams(params);
  for (const key of ["q", "query", "limit", "exactGeocode"]) allParams.delete(key);

  const allRows = (await getAllCourtAuctionRows(allParams)).filter(isRealEstateRow);
  const matchedRows = allRows
    .filter((row) => normalizeCourtSearchValue(courtAuctionSearchText(row)).includes(normalizedQuery))
    .sort((a, b) => courtSearchRank(a, normalizedQuery) - courtSearchRank(b, normalizedQuery))
    .slice(0, limit);
  const mapped = await mapWithConcurrency(matchedRows, 4, (row) =>
    hydrateCachedCourtAuctionRow(row, { exactGeocode: true })
  );
  const properties = mapped.map(normalizeProperty).filter(Boolean).map(overlayOfficialPrice);

  return {
    ok: true,
    source: "법원경매 전체 검색",
    query,
    matchedCount: properties.length,
    properties
  };
}

export async function fetchCourtAuctionViewportProperties(params, bounds, { exactGeocode = true } = {}) {
  const allRows = (await getAllCourtAuctionRows(params)).filter(isRealEstateRow);
  const roughRows = allRows.filter((row) => isRoughlyInsideBounds(row, bounds, courtRoughText));
  const shouldProxyGeocode = process.env.COURT_AUCTION_ENABLE_PROXY_GEOCODE === "1" && exactGeocode;
  const mapped = shouldProxyGeocode
    ? await mapWithConcurrency(roughRows, 8, (row) => hydrateCachedCourtAuctionRow(row, { exactGeocode }))
    : roughRows.map(mapCourtAuctionRow);
  const properties = mapped
    .map(normalizeProperty)
    .filter(Boolean)
    .map(overlayOfficialPrice)
    .filter((item) => isPropertyInsideBounds(item, bounds));

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

function courtRoughText(row) {
  return row?.address || row?.addr || row?.court || row?.court_name || courtAuctionSearchText(row);
}

async function getAllCourtAuctionRows(params) {
  const activeFilter = courtAuctionFilterValue(
    params.get("active") ?? process.env.COURT_AUCTION_ACTIVE ?? "all"
  );
  const requireCoordinates = courtAuctionRequireCoordinatesValue(
    params.get("require_coordinates") ?? process.env.COURT_AUCTION_REQUIRE_COORDINATES ?? "0"
  );
  const cacheKey = [
    activeFilter || "all",
    requireCoordinates || "0",
    params.get("sort") || process.env.COURT_AUCTION_SORT || "priority_desc",
    params.get("courtRows") || "500",
    params.get("courtPages") || "100"
  ].join(":");
  if (cache.rowsPromise && cache.rowsKey === cacheKey) return cache.rowsPromise;
  cache.rowsKey = cacheKey;

  cache.rowsPromise = (async () => {
    const baseUrl = courtAuctionBaseUrl();
    if (!baseUrl) {
      return getCourtAuctionSnapshotRows();
    }

    const scanLimit = clamp(numberFrom(params.get("courtRows")) || 500, 50, 500);
    const maxScanPages = clamp(numberFrom(params.get("courtPages")) || 100, 1, 100);
    const rows = [];
    let total = 0;

    for (let pageIndex = 0; pageIndex < maxScanPages; pageIndex += 1) {
      const pageOffset = pageIndex * scanLimit;
      const pageResult = await fetchJson(
        buildCourtAuctionUrl(params, { limit: scanLimit, offset: pageOffset }),
        courtAuctionRequestInit()
      );
      if (pageResult?.error) break;

      const pageRows = Array.isArray(pageResult?.items) ? pageResult.items : [];
      rows.push(...pageRows);
      total = total || numberFrom(pageResult?.total);

      if (pageRows.length < scanLimit) break;
      if (total && rows.length >= total) break;
    }

    return rows;
  })();

  // 업스트림 연결 실패가 캐시에 눌러앉지 않도록 거부된 프로미스는 비워서 다음 요청에서 재시도한다.
  cache.rowsPromise.catch(() => {
    if (cache.rowsKey === cacheKey) {
      cache.rowsPromise = null;
      cache.rowsKey = "";
    }
  });

  return cache.rowsPromise;
}

async function getCourtAuctionSnapshotRows() {
  if (cache.snapshotRowsPromise) return cache.snapshotRowsPromise;
  cache.snapshotRowsPromise = (async () => {
    // 스냅샷은 GitHub 100MB 한도 때문에 gzip이 기본. 이전 평문 JSON도 폴백으로 읽는다.
    const candidates = process.env.COURT_AUCTION_SNAPSHOT_PATH
      ? [resolve(process.env.COURT_AUCTION_SNAPSHOT_PATH)]
      : [join(root, "data/court-auctions.snapshot.json.gz"), join(root, "data/court-auctions.snapshot.json")];

    for (const snapshotPath of candidates) {
      try {
        const buffer = await readFile(snapshotPath);
        const text = snapshotPath.endsWith(".gz") ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
        const payload = JSON.parse(text);
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload.items)) return payload.items;
      } catch {
        continue;
      }
    }
    return [];
  })();
  return cache.snapshotRowsPromise;
}

async function hydrateCachedCourtAuctionRow(row, options) {
  const mapped = mapCourtAuctionRow(row);
  const cached = cache.properties.get(mapped.id);
  if (cached && hasUsableCoordinates(cached)) return cached;
  if (cached && !options?.exactGeocode) return cached;
  if (options?.exactGeocode && cache.geocodeMisses.has(mapped.id)) return cached || mapped;

  const hydrated = await hydrateCourtAuctionRow(mapped, options);
  if (hasUsableCoordinates(hydrated) || !options?.exactGeocode) {
    putBoundedMap(cache.properties, mapped.id, hydrated);
  } else if (options?.exactGeocode) {
    addBoundedSet(cache.geocodeMisses, mapped.id);
  }
  return hydrated;
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
  // 실좌표가 없는 물건은 추정 좌표로 흩뿌리지 않는다.
  // 주소와 핀 위치가 어긋난 "가짜 마커"가 신뢰를 깎아서, 좌표 미확보 물건은 지도에서 제외한다.
  // (exactGeocode 하이드레이션이 좌표를 찾으면 그때 지도에 올라온다)
  const originalLat = numberFrom(firstValue(row, ["lat", "latitude", "y"]));
  const originalLng = numberFrom(firstValue(row, ["lng", "longitude", "x"]));
  const point = originalLat && originalLng ? { lat: originalLat, lng: originalLng } : { lat: 0, lng: 0 };

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
    // 크롤러가 사전 계산해 실어 보낸 공시기준가(있으면 런타임 조회 불필요)
    officialPrice: normalizedPrice.official?.value || 0,
    officialPriceType: normalizedPrice.official?.type || "",
    officialPriceYear: normalizedPrice.official?.year || "",
    officialPriceDetail: normalizedPrice.official?.detail || null,
    landArea: normalizedArea.land_sqm || normalizedArea.total_sqm || extractAreaFromText(address) || 1,
    buildingArea: normalizedArea.building_sqm || null,
    lat: point.lat,
    lng: point.lng,
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

// 자동차·중기(건설기계) 같은 동산 경매는 부동산 지도에 올리지 않는다.
function isRealEstateRow(row) {
  const category = String((row.property && row.property.category) || row.category || "");
  return !/자동차|중기|건설기계/.test(category);
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
    row?.item_no,
    row?.case?.display_case_no,
    row?.case?.item_no,
    row?.property?.address?.raw,
    row?.property?.address?.clean,
    row?.category,
    row?.detail_url
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeCourtSearchValue(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-‐‑‒–—―·]/g, "");
}

function courtSearchRank(row, normalizedQuery) {
  const caseNo = normalizeCourtSearchValue(
    row?.case?.display_case_no || row?.case_no || row?.caseNo || ""
  );
  if (caseNo === normalizedQuery) return 0;
  if (caseNo.startsWith(normalizedQuery) || normalizedQuery.startsWith(caseNo)) return 1;
  return 2;
}

// 법원경매 API는 API 키로 잠겨 있다. 키가 없으면 헤더를 붙이지 않는다 -
// 로컬에서 잠그지 않은 서버(127.0.0.1:8000)를 그대로 쓰기 위해서다.
function courtAuctionRequestInit() {
  const key = process.env.COURT_AUCTION_API_KEY;
  return key ? { headers: { "X-API-Key": key } } : undefined;
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
  apiUrl.searchParams.set("sort", params.get("sort") || process.env.COURT_AUCTION_SORT || "priority_desc");

  const activeFilter = courtAuctionFilterValue(
    params.get("active") ?? process.env.COURT_AUCTION_ACTIVE ?? "all"
  );
  if (activeFilter) apiUrl.searchParams.set("active", activeFilter);

  const requireCoordinates = courtAuctionRequireCoordinatesValue(
    params.get("require_coordinates") ?? process.env.COURT_AUCTION_REQUIRE_COORDINATES ?? "0"
  );
  if (requireCoordinates) apiUrl.searchParams.set("require_coordinates", requireCoordinates);

  if (process.env.COURT_AUCTION_SERVER_BOUNDS_FILTER === "1") {
    for (const key of ["swLat", "swLng", "neLat", "neLng"]) {
      const value = params.get(key);
      if (value) apiUrl.searchParams.set(key, value);
    }
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

function courtAuctionFilterValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || ["all", "any", "*", "전체"].includes(normalized)) return "";
  return String(value).trim();
}

function courtAuctionRequireCoordinatesValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || ["0", "false", "no", "n", "off", "all", "any", "*", "전체"].includes(normalized)) return "";
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return "1";
  return String(value).trim();
}

function courtAuctionBaseUrl() {
  if (process.env.COURT_AUCTION_USE_SNAPSHOT === "1") return "";
  const configured = process.env.COURT_AUCTION_API_URL || process.env.COURT_AUCTION_API_BASE_URL;
  if (configured) return String(configured).replace(/\/$/, "");
  return process.env.VERCEL ? "" : "http://127.0.0.1:8000";
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

function firstMoneyValue(value) {
  const match = String(value || "").match(/[\d,]+/);
  return match ? match[0] : "";
}
