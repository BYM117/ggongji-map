import {
  clamp,
  fetchJson,
  firstValue,
  mapWithConcurrency,
  numberFrom,
  onbidStamp,
  parseQueryString,
  putBoundedMap
} from "./util.mjs";
import { guessRegion, hasUsableCoordinates, isPropertyInsideBounds, isRoughlyInsideBounds } from "./geo.mjs";
import { classifyItem, normalizeProperty, resolveAmbiguousCategories } from "./normalize.mjs";
import { fetchVworldPoint, fetchVworldRegion, lastVworldRegionError } from "./vworld.mjs";

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
// 좌표 조회가 통째로 막히는 일이 실제로 있다(배포 환경의 VWorld 장애). 그때 한 요청이
// 30초 제한까지 매달려 504로 죽으면 화면은 아무것도 못 받는다. 시간과 연속 실패로 끊는다.
const GEOCODE_TIME_BUDGET_MS = 8000;
const GEOCODE_GIVE_UP_AFTER = 8;

// 시군구를 못 구했을 때 쓰는 대비책. VWorld 역지오코딩이 배포 환경에서 간헐적으로
// 끊기는데, 그때 공매가 통째로 0건이 되면 안 된다. 시도만으로 걸러도 전국을 긁는 것보다
// 훨씬 낫다(서울 4,993 / 전국 54,849).
//
// 이름을 온비드 응답에서 확인한 값 그대로 적는다. 표준과 다른 게 섞여 있다
// (광주·전남이 전남광주통합특별시 하나로 합쳐져 있고, 강원/전북은 특별자치도다).
// 광주와 전남은 중심이 멀어 각각 한 줄씩 두고 같은 이름을 가리킨다.
const ONBID_PROVINCE_CENTERS = [
  ["서울특별시", 37.5665, 126.978],
  ["부산광역시", 35.1796, 129.0756],
  ["대구광역시", 35.8714, 128.6014],
  ["인천광역시", 37.4563, 126.7052],
  ["대전광역시", 36.3504, 127.3845],
  ["울산광역시", 35.5384, 129.3114],
  ["세종특별자치시", 36.48, 127.289],
  ["경기도", 37.4138, 127.5183],
  ["강원특별자치도", 37.8228, 128.1555],
  ["충청북도", 36.8, 127.7],
  ["충청남도", 36.5184, 126.8],
  ["전북특별자치도", 35.7175, 127.153],
  ["경상북도", 36.4919, 128.8889],
  ["경상남도", 35.4606, 128.2132],
  ["제주특별자치도", 33.4996, 126.5312],
  ["전남광주통합특별시", 35.1595, 126.8526],
  ["전남광주통합특별시", 34.8679, 126.991]
];

// 좌표 조회가 실패한 주소를 아주 잠깐만 들고 있는다. 아예 안 들고 있으면 느린 장애에서
// 같은 주소를 화면마다 다시 물어보고, 오래 들고 있으면 상대가 살아난 뒤에도 빈 채로 남는다.
const GEOCODE_FAILURE_TTL_MS = 60 * 1000;

const cache = {
  regionRows: new Map(), // "시도|시군구" -> { promise, expiresAt }
  points: new Map()      // 주소 -> { point, expiresAt }
};

// 최저입찰가·입찰 기간이 어느 필드에 실려 오는지는 한 곳에만 적는다. 회차를 고르는 쪽과
// 물건을 만드는 쪽이 서로 다른 필드를 보면, 고른 회차와 찍히는 값이 어긋난다.
const MIN_BID_KEYS = [
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
];
const ROUND_START_KEYS = ["cltrBidBgngDt", "CLTR_BID_BGNG_DT", "PBCT_BEGN_DTM", "pbctBegnDtm"];
const ROUND_END_KEYS = ["cltrBidEndDt", "CLTR_BID_END_DT", "PBCT_CLS_DTM", "pbctClsDtm"];

function roundPrice(row) {
  return numberFrom(firstValue(row, MIN_BID_KEYS));
}

function roundStart(row) {
  return String(firstValue(row, ROUND_START_KEYS) || "");
}

function roundEnd(row) {
  return String(firstValue(row, ROUND_END_KEYS) || "");
}

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

  // 여기도 회차마다 한 줄씩 온다. 줄이지 않으면 같은 물건이 회차 수만큼 지도에 겹쳐 뜬다.
  const limitedRows = pickCurrentRoundRows(rows).slice(0, maxProperties);
  const mapped = await mapWithConcurrency(limitedRows, 8, hydrateCachedOnbidRow);
  const properties = await resolveAmbiguousCategories(mapped.map(normalizeProperty).filter(Boolean));

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
      diagnostics: {
        source: "onbid",
        regions: [],
        scannedRows: 0,
        candidateCount: 0,
        returnedCount: 0,
        message: "region_lookup_failed",
        regionError: lastVworldRegionError()
      }
    };
  }

  const regionResults = await Promise.all(
    regions.map((region) =>
      getRegionOnbidRows(params, region).catch((error) => {
        console.error("onbid region fetch failed", region.sido, region.sigungu, String(error?.message || "").slice(0, 80));
        return { rows: [], truncated: false };
      })
    )
  );
  const allRows = regionResults.flatMap((result) => result.rows);
  const roughRows = allRows.filter((row) => isRoughlyInsideBounds(mapOnbidRow(row), bounds));
  // 온비드는 같은 물건(cltrMngNo)을 입찰 회차마다 한 줄씩 보낸다. 실측으로 89줄이
  // 실제 13개 물건이었다. 좌표를 구하기 전에 줄이지 않으면 아래 예산을 회차가 다 먹는다.
  const uniqueRows = pickCurrentRoundRows(roughRows);
  // 좌표를 새로 구하는 건 물건당 왕복이라, 한 화면에서 무한정 늘어나지 않게 잘라둔다.
  const geocodeRows = uniqueRows.slice(0, GEOCODE_BUDGET);

  const deadline = Date.now() + GEOCODE_TIME_BUDGET_MS;
  let attempts = 0;
  let successes = 0;
  const mapped = await mapWithConcurrency(geocodeRows, 8, async (row) => {
    // 시간을 다 썼거나, 초반이 전부 실패했으면(좌표 서버가 죽은 것) 더 매달리지 않는다.
    // 좌표 없는 물건은 아래 경계 필터에서 자연히 빠진다.
    if (Date.now() > deadline) return mapOnbidRow(row);
    if (attempts >= GEOCODE_GIVE_UP_AFTER && successes === 0) return mapOnbidRow(row);

    attempts += 1;
    const hydrated = await hydrateCachedOnbidRow(row);
    if (hasUsableCoordinates(hydrated)) successes += 1;
    return hydrated;
  });
  const properties = await resolveAmbiguousCategories(
    mapped.map(normalizeProperty).filter(Boolean).filter((item) => isPropertyInsideBounds(item, bounds))
  );
  return {
    ok: true,
    source: "온비드",
    properties,
    diagnostics: {
      source: "onbid",
      regions: regions.map((region) => `${region.sido} ${region.sigungu}`.trim()),
      regionSource: regions.some((region) => region.sigungu) ? "vworld" : "province_fallback",
      regionError: lastVworldRegionError(),
      scannedRows: allRows.length,
      // 뒷쪽을 다 못 받은 지역 수. 0이 아니면 "물건이 적다"가 상대 사정이 아니라 우리 예산 탓이다.
      truncatedRegions: regionResults.filter((result) => result.truncated).length,
      candidateCount: roughRows.length,
      uniqueCount: uniqueRows.length,
      geocodedCount: geocodeRows.length,
      geocodeAttempts: attempts,
      geocodeSuccesses: successes,
      returnedCount: properties.length
    }
  };
}

// 물건 하나를 한 줄로 줄인다. **어느 줄을 남기는지가 최저가를 정한다.**
//
// 예전에는 "먼저 본 줄"을 남겼다(dedupe). 그런데 이 API는 입찰 시작일 내림차순으로 주므로
// 먼저 오는 줄이 가장 먼 미래, 곧 가장 싼 마지막 회차다. 그래서 서울 692개 물건 중
// 658개(95%)의 최저가가 "아직 열리지도 않은 마지막 회차" 가격으로 들어가 있었다.
// 2026-04538-001은 감정가 2.61억인데 045회차(감정가의 10%) 0.261억이 최저가로 박혔고,
// 실제로 다음에 열리는 036회차는 감정가 그대로인 2.61억이었다. 유찰 0회인 물건이
// 감정가의 10%로 보이던 것이 이것이다.
//
// 지금 내야 하는 값은 **아직 끝나지 않은 회차 중 가장 먼저 시작하는 것**이다 —
// 열려 있으면 그 회차, 다 미래면 다음에 열리는 회차. 상세(lib/onbid-detail.mjs)의
// 회차표와 같은 규칙이고, 실측 10건에서 두 경로가 같은 값을 냈다.
function pickCurrentRoundRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const mapped = mapOnbidRow(row);
    const key = mapped.id || `${mapped.caseNo}:${mapped.address}`;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(pickCurrentRound);
}

function pickCurrentRound(rounds) {
  if (rounds.length === 1) return rounds[0];

  const stamp = onbidStamp();
  // 값이 없는 줄은 "싼 회차"가 아니라 못 읽은 줄이다. 값이 있는 줄이 하나라도 있으면 그쪽만 본다.
  const priced = rounds.filter((row) => roundPrice(row) > 0);
  const pool = priced.length ? priced : rounds;
  // 이미 끝난 회차는 지금 낼 수 있는 값이 아니다. 목록 API는 끝난 회차를 안 주는 것으로
  // 보이지만(실측 5,634줄 전부 미래), 그 전제가 조용히 깨지면 값이 통째로 틀리므로 직접 거른다.
  const live = pool.filter((row) => {
    const end = roundEnd(row);
    return !end || end >= stamp;
  });
  const candidates = live.length ? live : pool;

  return candidates.reduce((best, row) => (sortableStart(row) < sortableStart(best) ? row : best));
}

// 시작일이 없는 줄이 "제일 이른 회차"로 뽑히면 안 된다. 비교에서 맨 뒤로 보낸다.
function sortableStart(row) {
  return roundStart(row) || "999999999999";
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
  if (unique.size) return [...unique.values()];

  return fallbackProvinces(midLat, midLng);
}

// 화면 중심에서 가까운 시도 두 곳. 경계(서울/경기, 부산/경남)에 걸친 화면을 놓치지 않으려고
// 한 곳만 고르지 않는다. 시군구가 없으므로 받아오는 양이 많아 페이지 상한이 그대로 걸린다.
function fallbackProvinces(lat, lng) {
  const ranked = ONBID_PROVINCE_CENTERS.map(([sido, centerLat, centerLng]) => ({
    sido,
    sigungu: "",
    distance: (centerLat - lat) ** 2 + (centerLng - lng) ** 2
  })).sort((a, b) => a.distance - b.distance);

  const picked = [];
  for (const region of ranked) {
    if (picked.some((item) => item.sido === region.sido)) continue;
    picked.push({ sido: region.sido, sigungu: "" });
    if (picked.length === 2) break;
  }
  return picked;
}

// 시군구 하나치를 받아 캐시한다. 같은 구를 보는 다음 요청은 왕복 없이 끝난다.
//
// **마지막 쪽부터 받는다.** 이 API는 입찰 시작일 내림차순으로 주므로 앞쪽은 가장 먼 미래
// 회차이고, 곧 열리는 회차는 맨 뒤에 있다. 우리가 최저가로 쓸 값은 뒤쪽에 있다.
// 앞에서부터 세 쪽만 받던 예전 방식은 경기도(11,632줄 = 12쪽)에서 먼 미래 회차만 받아,
// 물건마다 "가장 싼 회차"밖에 볼 게 없었다.
//
// 뒤에서부터 잘라야 하는 이유가 하나 더 있다. 한 물건의 줄들은 흩어져 있지만 그중
// **가장 이른 회차는 언제나 가장 뒤**에 있다(날짜 내림차순이므로). 그러니 연속된 뒷부분만
// 받으면, 거기 한 줄이라도 보이는 물건은 그 물건의 가장 이른 회차도 반드시 같이 보인다 —
// 값이 틀릴 수가 없다. 예산이 모자라면 물건이 아예 안 보일 뿐, 틀린 값이 뜨지는 않는다.
// 앞에서부터 자르면 정반대로, 모든 물건이 틀린 값으로 다 보인다.
// (실측 경기도: 뒤 3쪽 2,632줄로 전체 1,539개 중 1,181개를 제값으로 받는다.)
async function getRegionOnbidRows(params, region) {
  const cacheKey = `${region.sido}|${region.sigungu}`;
  const cached = cache.regionRows.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) cache.regionRows.delete(cacheKey);

  const task = (async () => {
    // 몇 쪽인지부터 묻는다. 한 줄만 받는 정찰이라 2KB도 안 되고, 이 답이 없으면
    // 마지막 쪽이 몇 쪽인지 알 수가 없다.
    const probe = await fetchRegionPage(params, region, 1, 1);
    if (!probe) return { rows: [], truncated: false };

    const totalCount = extractTotalCount(probe);
    if (!totalCount) {
      // 총 건수를 안 주면 뒤에서부터 셀 수가 없다. 첫 쪽만 받고 잘렸다고 표시한다.
      // 여기서 조용히 넘어가면 "이 지역엔 물건이 적다"로 읽힌다.
      const head = await fetchRegionPage(params, region, 1, REGION_ROWS);
      return { rows: head ? extractRows(head) : [], truncated: true };
    }

    const lastPage = Math.max(Math.ceil(totalCount / REGION_ROWS), 1);
    const firstPage = Math.max(lastPage - REGION_MAX_PAGES + 1, 1);

    // 쪽은 한 번에 하나씩 받는다. 화면 하나가 이미 지역 다섯 곳을 나란히 부르고 있어서,
    // 쪽까지 병렬로 쏘면 한 번에 스무 개가 나간다. 이 API는 **초당** 요청 제한이 있고,
    // 넘기면 429를 준다(실측 2026-09-18: 강남구·노원구가 통째로 0건이 됐다).
    //
    // 실패한 쪽에서 멈추고 받은 데까지만 쓴다. 건너뛰고 계속하면 받은 쪽이 끊긴 구간이
    // 되는데, 아래 "뒤에서부터"의 안전성은 **연속된** 뒷부분일 때만 성립한다.
    // 중간이 비면 어떤 물건의 가장 이른 회차가 그 구멍에 빠져 값이 조용히 틀려진다.
    const results = [];
    let coveredFrom = firstPage;
    for (let page = lastPage; page >= firstPage; page -= 1) {
      const result = await fetchRegionPage(params, region, page, REGION_ROWS);
      if (!result) {
        coveredFrom = page + 1;
        break;
      }
      results.push(result);
    }

    return {
      rows: results.flatMap(extractRows),
      truncated: coveredFrom > 1
    };
  })();

  const entry = { promise: task, expiresAt: Date.now() + REGION_CACHE_TTL_MS };
  putBoundedMap(cache.regionRows, cacheKey, entry, REGION_CACHE_MAX);
  // 실패한 조회가 10분간 눌러앉지 않도록 비운다.
  task.catch(() => {
    if (cache.regionRows.get(cacheKey) === entry) cache.regionRows.delete(cacheKey);
  });

  return task;
}

async function fetchRegionPage(params, region, page, rows) {
  const pageParams = new URLSearchParams(params);
  pageParams.set("pageNo", String(page));
  pageParams.set("numOfRows", String(rows));
  pageParams.set("lctnSdnm", region.sido);
  if (region.sigungu) pageParams.set("lctnSggnm", region.sigungu);

  const result = await fetchJson(buildOnbidUrl(pageParams));
  // 오류 응답을 빈 쪽으로 읽으면 "이 지역엔 물건이 없다"가 된다. 못 물어본 것과 구분한다.
  const errorPayload = makeOnbidErrorPayload(result, params);
  if (errorPayload) {
    console.error(
      "onbid list page failed",
      `${region.sido} ${region.sigungu}`.trim(),
      `p${page}`,
      String(errorPayload.message || "").slice(0, 80)
    );
    return null;
  }
  return result;
}

// **좌표만** 캐시한다. 예전에는 정규화된 행을 통째로 물건번호에 걸어 두었는데, 그러면
// 회차가 넘어가 최저가와 입찰 기일이 바뀌어도 프로세스가 사는 동안 옛 값이 계속 나왔다.
// 주소가 같으면 좌표는 변하지 않지만 가격과 기일은 매주 변한다 — 들고 있어도 되는 건 앞의 것뿐이다.
async function hydrateCachedOnbidRow(row) {
  const mapped = mapOnbidRow(row);
  if (hasRowCoordinates(mapped)) return mapped;

  const query = String(mapped.address || mapped.title || "").trim();
  if (!query) return mapped;

  const cached = cache.points.get(query);
  if (cached && cached.expiresAt > Date.now()) return applyPoint(mapped, cached.point);
  if (cached) cache.points.delete(query);

  const point = await fetchVworldPoint(query);
  // 못 찾은 주소는 잠깐만 들고 있는다. 좌표가 없다는 것이 영영 없다는 뜻은 아니다.
  putBoundedMap(cache.points, query, {
    point,
    expiresAt: point ? Number.MAX_SAFE_INTEGER : Date.now() + GEOCODE_FAILURE_TTL_MS
  });
  return applyPoint(mapped, point);
}

function hasRowCoordinates(row) {
  return Boolean(
    numberFrom(firstValue(row, ["lat", "latitude", "y"])) && numberFrom(firstValue(row, ["lng", "longitude", "x"]))
  );
}

function applyPoint(row, point) {
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

  // data.go.kr 공통 오류는 우리가 읽던 것과 모양이 완전히 다르다.
  // {"OpenAPI_ServiceResponse":{"cmmMsgHeader":{"errMsg":"...","returnReasonCode":"23"}}}
  // 이 모양을 모르면 "물건 배열이 없다" → 빈 쪽 → **이 지역엔 물건이 없다**로 읽힌다.
  // 실측(2026-09-18): 초당 요청 제한(HTTP 429, 코드 23)에 걸린 구가 통째로 0건이 됐고,
  // 오류라는 흔적이 로그에도 진단에도 남지 않았다.
  const commonHeader = result?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (commonHeader?.errMsg || commonHeader?.returnReasonCode) {
    return {
      ok: false,
      error: "onbid_api_error",
      message: `${commonHeader.returnAuthMsg || commonHeader.errMsg || "온비드 API 오류"} (코드 ${commonHeader.returnReasonCode || "?"})`,
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
    minBid: firstValue(row, MIN_BID_KEYS),
    appraisal: firstValue(row, ["APSL_ASES_AVG_AMT", "appraisal", "감정가", "감정평가금액", "apslEvlAmt"]),
    landArea: firstValue(row, ["LAND_AREA", "landArea", "토지면적", "AREA", "area", "landSqms", "bldSqms"]),
    pnu: firstValue(row, ["ltnoPnu", "rdnmPnu"]),
    bidDate: firstValue(row, ["PBCT_CLS_DTM", "pbctClsDtm", "PBCT_BEGN_DTM", "pbctBegnDtm", "입찰일", "cltrBidEndDt"]),
    // failCount를 여기서 만들지 않는다. usbdNft는 유찰 횟수가 아니다 — 이번 공고에서
    // 이미 떨어진 횟수가 안 들어와서, 감정가의 10%까지 내려온 물건도 0으로 온다
    // (2026-09-18 실측: 서울 502물건 중 usbdNft=0인 491개가 전부 감정가 미만이었다).
    // 그 0을 "유찰 0회"로 실어 보내면 화면이 위험 신호를 통째로 잃는다. 값을 안 실으면
    // normalizeProperty가 null로 남겨 "모른다"로 표시된다.
    // 유찰은 회차표가 온전한 상세에서만 센다 — lib/onbid-detail.mjs의 deriveFailCount().
    source: "온비드 OpenAPI",
    checks: ["온비드", "권리확인 필요"]
  };
}

function buildOnbidAddress(row) {
  return [row.lctnSdnm, row.lctnSggnm, row.lctnEmdNm].filter(Boolean).join(" ");
}
