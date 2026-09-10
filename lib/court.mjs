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
import { classifyItem, normalizeProperty, resolveAmbiguousCategories } from "./normalize.mjs";
import { pickClassifyAddress } from "../categories.js";
import { cleanGeocodeAddress, fetchVworldPoint } from "./vworld.mjs";
import { overlayOfficialPrice } from "./official-prices.mjs";

const root = resolve(".");

// 뷰포트 행 캐시는 "지역별"이어야 한다. 예전에는 슬롯 하나에 지역 구분 없이 담아서,
// 그 인스턴스가 처음 받은 지역(보통 서울)의 목록을 다른 지역 요청에도 그대로 돌려줬다.
// 그래서 부산·대구·광주가 "물건 없음"으로 보였다.
const ROWS_GRID_DEGREES = 0.1; // 약 11km. 이 격자 안에서의 이동/줌은 캐시를 재사용한다.
const ROWS_CACHE_TTL_MS = 5 * 60 * 1000;
const ROWS_CACHE_MAX = 40;

const cache = {
  rows: new Map(), // 격자키 -> { promise, expiresAt }
  snapshotRowsPromise: null,
  properties: new Map(),
  geocodeMisses: new Set()
};

// 뷰포트 좌표를 그대로 캐시 키에 쓰면 지도를 1px만 움직여도 키가 바뀌어 캐시가 무용지물이다.
// 격자에 맞춰 바깥으로 넓힌 사각형을 키로 쓰고, 업스트림에도 같은 사각형으로 요청한다.
function gridAlignedBounds(params) {
  if (process.env.COURT_AUCTION_SERVER_BOUNDS_FILTER !== "1") return null;

  const swLat = numberFrom(params.get("swLat"));
  const swLng = numberFrom(params.get("swLng"));
  const neLat = numberFrom(params.get("neLat"));
  const neLng = numberFrom(params.get("neLng"));
  if (!swLat || !swLng || !neLat || !neLng) return null;

  const snap = (value, round) => Number((round(value / ROWS_GRID_DEGREES) * ROWS_GRID_DEGREES).toFixed(4));
  return {
    swLat: snap(Math.min(swLat, neLat), Math.floor),
    swLng: snap(Math.min(swLng, neLng), Math.floor),
    neLat: snap(Math.max(swLat, neLat), Math.ceil),
    neLng: snap(Math.max(swLng, neLng), Math.ceil)
  };
}

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
  const properties = await resolveAmbiguousCategories(
    mapped.map(normalizeProperty).filter(Boolean).map(overlayOfficialPrice)
  );

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

  // "전체 검색"은 전국이 대상이다. 예전에는 전 물건을 내려받아 메모리에서 걸렀는데,
  // 뷰포트 캐시를 같이 쓰는 바람에 실제로는 "그 서버가 마지막에 본 지역"만 검색됐다.
  // 업스트림이 q 검색을 지원하므로 그대로 위임한다(전국 대상, 응답도 훨씬 빠르다).
  const searchParams = new URLSearchParams(params);
  for (const key of ["swLat", "swLng", "neLat", "neLng", "sources", "zoom", "query"]) searchParams.delete(key);
  searchParams.set("q", query);
  searchParams.set("limit", String(limit));
  searchParams.set("maxProperties", String(limit));
  searchParams.set("exactGeocode", "1");

  const result = await fetchCourtAuctionProperties(searchParams);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      query,
      matchedCount: 0,
      properties: []
    };
  }

  return {
    ok: true,
    source: "법원경매 전체 검색",
    query,
    matchedCount: result.properties.length,
    properties: result.properties
  };
}

export async function fetchCourtAuctionViewportProperties(params, bounds, { exactGeocode = true } = {}) {
  const allRows = (await getAllCourtAuctionRows(params)).filter(isRealEstateRow);
  const roughRows = allRows.filter((row) => isRoughlyInsideBounds(row, bounds, courtRoughText));
  const shouldProxyGeocode = process.env.COURT_AUCTION_ENABLE_PROXY_GEOCODE === "1" && exactGeocode;
  const mapped = shouldProxyGeocode
    ? await mapWithConcurrency(roughRows, 8, (row) => hydrateCachedCourtAuctionRow(row, { exactGeocode }))
    : roughRows.map(mapCourtAuctionRow);
  const properties = await resolveAmbiguousCategories(
    mapped
      .map(normalizeProperty)
      .filter(Boolean)
      .map(overlayOfficialPrice)
      .filter((item) => isPropertyInsideBounds(item, bounds))
  );

  return {
    ok: true,
    source: "법원경매",
    properties,
    diagnostics: {
      source: "court",
      scannedRows: allRows.length,
      candidateCount: roughRows.length,
      returnedCount: properties.length,
      classification: classificationDiagnostics(properties)
    }
  };
}

// 분류가 실제로 무엇에 기대고 있는지 응답에 남긴다.
// 목록구분(집합건물/토지/건물)은 주소 대괄호에서만 나오므로, 공급 API가 주소를
// 정리해서 보내기 시작하면 saleForm이 "other"로 쏠린다. 그때 여기서 바로 보인다.
function classificationDiagnostics(properties) {
  const total = properties.length;
  if (!total) return { total: 0 };
  const withListingKind = properties.filter((item) => item.saleForm && item.saleForm !== "other").length;
  return {
    total,
    withListingKind,
    unconfident: properties.filter((item) => item.categoryConfident === false).length,
    unknown: properties.filter((item) => item.categorySub === "unknown").length
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
  const bounds = gridAlignedBounds(params);
  const cacheKey = [
    activeFilter || "all",
    requireCoordinates || "0",
    params.get("sort") || process.env.COURT_AUCTION_SORT || "priority_desc",
    params.get("courtRows") || "500",
    params.get("courtPages") || "100",
    // 지역을 키에 넣지 않으면 다른 지역 요청이 남의 목록을 그대로 받아 "물건 없음"이 된다.
    bounds ? `${bounds.swLat},${bounds.swLng},${bounds.neLat},${bounds.neLng}` : "nationwide"
  ].join(":");

  const cached = cache.rows.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) cache.rows.delete(cacheKey);

  const task = (async () => {
    const baseUrl = courtAuctionBaseUrl();
    if (!baseUrl) {
      return { rows: await getCourtAuctionSnapshotRows(), complete: true };
    }

    const scanLimit = clamp(numberFrom(params.get("courtRows")) || 500, 50, 500);
    const maxScanPages = clamp(numberFrom(params.get("courtPages")) || 100, 1, 100);

    // 페이지를 한 장씩 줄 세워 받으면 넓은 화면에서 죽는다. 전국은 32,000건이라
    // 500건씩 65번을 왕복해야 하고, 그것만 26초라 Vercel 30초 제한에 걸려 504가 났다.
    // 첫 장으로 total을 알아낸 뒤 나머지는 한꺼번에 받는다.
    const fetchPage = async (pageIndex) => {
      const pageResult = await fetchJson(
        buildCourtAuctionUrl(params, { limit: scanLimit, offset: pageIndex * scanLimit, bounds }),
        courtAuctionRequestInit()
      );
      if (pageResult?.error) return null;
      return Array.isArray(pageResult?.items)
        ? { items: pageResult.items, total: numberFrom(pageResult?.total) }
        : null;
    };

    const first = await fetchPage(0);
    if (!first) return { rows: [], complete: false };

    const total = first.total;
    const rows = [...first.items];

    // total을 모르면 뒤에 몇 장이 있는지 알 수 없다. 그때만 예전처럼 한 장씩 이어 받는다.
    if (!total) {
      let complete = first.items.length < scanLimit;
      for (let pageIndex = 1; pageIndex < maxScanPages && !complete; pageIndex += 1) {
        const page = await fetchPage(pageIndex);
        if (!page) break;
        rows.push(...page.items);
        if (page.items.length < scanLimit) complete = true;
      }
      return { rows, complete };
    }

    const wantedPages = Math.min(Math.ceil(total / scanLimit), maxScanPages);
    const restPages = [];
    for (let pageIndex = 1; pageIndex < wantedPages; pageIndex += 1) restPages.push(pageIndex);

    // 업스트림도 서버리스라 동시 요청을 무한정 열지 않는다. 8장씩 묶어 받는다.
    const pages = await mapWithConcurrency(restPages, 8, fetchPage);
    for (const page of pages) {
      if (!page) continue; // 한 장이 비면 아래 total 대조에서 불완전으로 잡힌다
      rows.push(...page.items);
    }

    // 짧은 응답을 "마지막 장"으로 착각하면 잘린 목록이 캐시에 눌러앉는다.
    // total과 대조해 다 못 받았으면 불완전으로 남겨 다음 요청에서 다시 받는다.
    return { rows, complete: rows.length >= Math.min(total, wantedPages * scanLimit) };
  })();

  const entry = { promise: task.then((result) => result.rows), expiresAt: Date.now() + ROWS_CACHE_TTL_MS };
  putBoundedMap(cache.rows, cacheKey, entry, ROWS_CACHE_MAX);

  // 업스트림이 한 번 짧게 응답하면(또는 끊기면) 잘린 목록이다. 그걸 캐시에 눌러앉히면
  // 그 인스턴스는 계속 잘린 목록만 보여주므로, 불완전하면 캐시에서 뺀다.
  const evict = () => {
    if (cache.rows.get(cacheKey) === entry) cache.rows.delete(cacheKey);
  };
  task.then((result) => {
    if (!result.complete) evict();
  }, evict);

  return entry.promise;
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

  // 크롤러의 type_guess는 쓰지 않는다. 법원 검색 그룹 라벨("상가,오피스텔,근린시설")을
  // 부분 문자열로 훑어서 4천 건을 통째로 오피스텔로 만들기 때문이다. 여기서 다시 분류한다.
  //
  // 분류는 주소 끝 대괄호(목록구분·지목)에 크게 기댄다. 공급 API가 주소를 정리해서 보내기
  // 시작하면 그 신호가 사라지므로, 대괄호가 살아 있는 필드를 골라 쓴다.
  // 분류는 주소 끝 대괄호(목록구분·지목)에 크게 기댄다.
  // 공급 API가 그 내용을 address.detail로 이미 뽑아서 주므로 그걸 먼저 쓴다.
  // raw를 직접 정규식으로 뜯는 것보다 안전하다 — 원문 표기가 바뀌어도 detail은 같은 뜻을 유지한다.
  // 건물명(지식산업센터 브랜드 등)은 detail에 없으므로 clean과 합쳐서 넘긴다.
  // 실측: 32,033건 전부 detail이 있고 raw의 대괄호 내용과 100% 일치한다.
  const classifyAddress = pickClassifyAddress(
    normalizedAddress.detail ? `${cleanAddress || address} [${normalizedAddress.detail}]` : "",
    normalizedAddress.raw,
    row.address,
    address
  );
  const classified = classifyItem({ category, address: classifyAddress, title: cleanAddress || address });

  return {
    ...row,
    id: row.id || [source, caseNo, itemNo].filter(Boolean).join(":"),
    caseNo: [caseNo, itemNo ? `물건 ${itemNo}` : ""].filter(Boolean).join(" · ") || "법원경매",
    title: `${classified.label} 경매물건`,
    type: classified.type,
    categoryGroup: classified.group,
    categorySub: classified.sub,
    categoryConfident: classified.confident,
    saleForm: classified.saleForm,
    // 수집기가 목록에 실어 보내는 건축물대장 주용도. 미확정 물건의 용도를 좁히는 데 쓴다.
    buildingPurpose: normalizedProperty.building?.main_purpose || row.building?.main_purpose || "",
    landUseZone: normalizedProperty.land_use?.zone || row.land_use?.zone || "",
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
      // 원문 링크는 상세 패널의 "법원경매정보에서 원문 보기"가 담당한다.
    ].filter(Boolean).join(" · "),
    zoning: category || "확인 필요",
    source,
    checks: uniqueValues(checks)
  };
}

// 자동차·중기·선박 같은 동산 경매는 부동산 지도에 올리지 않는다.
// 카테고리 문자열만 보면 "기타"로 들어온 선박·건설기계를 놓치므로 주소까지 함께 본다.
function isRealEstateRow(row) {
  const category = String((row.property && row.property.category) || row.category || "");
  const address = String((row.property && row.property.address && row.property.address.raw) || row.address || "");
  const { sub } = classifyItem({ category, address });
  return sub !== "vehicle" && sub !== "vessel";
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

// 법원경매 API는 API 키로 잠겨 있다. 키가 없으면 헤더를 붙이지 않는다 -
// 로컬에서 잠그지 않은 서버(127.0.0.1:8000)를 그대로 쓰기 위해서다.
function courtAuctionRequestInit() {
  const key = process.env.COURT_AUCTION_API_KEY;
  return key ? { headers: { "X-API-Key": key } } : undefined;
}

function buildCourtAuctionUrl(params, { limit, offset, bounds = null }) {
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

  // 캐시 키와 업스트림 요청 범위는 반드시 같아야 한다. 어긋나면 A지역 목록에
  // "B지역 것"이라는 라벨이 붙어서 엉뚱한 지역이 빈 화면으로 나온다.
  if (bounds) {
    apiUrl.searchParams.set("swLat", String(bounds.swLat));
    apiUrl.searchParams.set("swLng", String(bounds.swLng));
    apiUrl.searchParams.set("neLat", String(bounds.neLat));
    apiUrl.searchParams.set("neLng", String(bounds.neLng));
  } else if (process.env.COURT_AUCTION_SERVER_BOUNDS_FILTER === "1") {
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
