import { fetchJsonRetry, numberFrom, putBoundedMap, uniqueValues } from "./util.mjs";

export async function fetchLandPrice(params) {
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

  return fetchJsonRetry(apiUrl);
}

// 같은 PNU를 반복 조회하지 않도록 연도별 세대 목록을 캐시한다. (아파트 단지는 수천 행)
const housingRowsCache = new Map();

// 공동주택가격(아파트/빌라/다세대) 및 개별주택가격(단독/다가구) 조회.
// 개별공시지가와 같은 VWorld NED 계열이라 동일한 key+pnu 방식으로 호출한다.
export async function fetchHousingPrice(params) {
  const pnu = params.get("pnu");
  const requestedYear = numberFrom(params.get("year")) || new Date().getFullYear();
  const serviceKey = process.env.VWORLD_API_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  const domain = vworldDomain();
  const kindParam = String(params.get("kind") || "apart").toLowerCase();
  const kind = kindParam.startsWith("indvd") || kindParam.startsWith("house") ? "indvd" : "apart";

  if (!pnu) return { ok: false, error: "missing_pnu" };
  if (!serviceKey) {
    return {
      ok: false,
      error: "missing_key",
      message: ".env에 VWORLD_API_KEY를 넣으면 주택 공시가격 API를 호출합니다."
    };
  }

  const years = [requestedYear, requestedYear - 1, requestedYear - 2]
    .filter((value, index, array) => value > 2000 && array.indexOf(value) === index)
    .map(String);

  if (kind === "indvd") {
    for (const year of years) {
      const rows = await fetchHousingRows("getIndvdHousingPriceAttr", "indvdHousingPrices", { pnu, year, serviceKey, domain, maxPages: 1 });
      const first = rows.find((row) => numberFrom(row.housePc) > 0);
      if (first) {
        return {
          ok: true,
          source: "개별주택가격",
          kind: "indvdHousing",
          pnu,
          year,
          price: numberFrom(first.housePc),
          matched: {
            landArea: numberFrom(first.ladRegstrAr) || null,
            buildingArea: numberFrom(first.buldCalcTotAr) || null
          },
          matchedCount: 1,
          totalCount: rows.length
        };
      }
    }
    return { ok: true, source: "개별주택가격", kind: "indvdHousing", pnu, year: years[0], price: null, matchedCount: 0, totalCount: 0, message: "해당 PNU의 개별주택가격이 없습니다." };
  }

  const unit = {
    dong: normalizeUnitToken(params.get("dong")),
    ho: normalizeUnitToken(params.get("ho")),
    area: numberFrom(params.get("area"))
  };
  if (!unit.ho) {
    const parsed = parseUnitFromAddress(params.get("address") || "");
    unit.dong = unit.dong || parsed.dong;
    unit.ho = parsed.ho;
  }

  for (const year of years) {
    const rows = await fetchHousingRows("getApartHousingPriceAttr", "apartHousingPrices", { pnu, year, serviceKey, domain, maxPages: 5 });
    if (!rows.length) continue;

    const match = pickApartUnit(rows, unit);
    if (match) {
      return {
        ok: true,
        source: "공동주택가격",
        kind: "apartHousing",
        pnu,
        year,
        price: numberFrom(match.pblntfPc),
        matched: {
          name: match.aphusNm || "",
          dong: match.dongNm || "",
          ho: match.hoNm || "",
          area: numberFrom(match.prvuseAr) || null
        },
        matchedCount: 1,
        totalCount: rows.length
      };
    }

    // 세대 목록은 있는데 동/호가 안 맞으면 연도를 바꿔도 결과가 같으므로 바로 종료한다.
    return {
      ok: true,
      source: "공동주택가격",
      kind: "apartHousing",
      pnu,
      year,
      price: null,
      matchedCount: 0,
      totalCount: rows.length,
      requestedUnit: { dong: unit.dong, ho: unit.ho },
      message: unit.ho ? "동/호가 일치하는 세대를 찾지 못했습니다." : "주소에서 호수를 읽지 못해 세대를 특정할 수 없습니다."
    };
  }

  return { ok: true, source: "공동주택가격", kind: "apartHousing", pnu, year: years[0], price: null, matchedCount: 0, totalCount: 0, message: "해당 PNU의 공동주택가격이 없습니다." };
}

async function fetchHousingRows(endpoint, bucketKey, { pnu, year, serviceKey, domain, maxPages }) {
  const cacheKey = `${endpoint}:${pnu}:${year}`;
  if (housingRowsCache.has(cacheKey)) return housingRowsCache.get(cacheKey);

  const promise = (async () => {
    const rows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const apiUrl = new URL(`https://api.vworld.kr/ned/data/${endpoint}`);
      apiUrl.searchParams.set("key", serviceKey);
      apiUrl.searchParams.set("pnu", pnu);
      apiUrl.searchParams.set("stdrYear", year);
      apiUrl.searchParams.set("format", "json");
      apiUrl.searchParams.set("numOfRows", "1000");
      apiUrl.searchParams.set("pageNo", String(page));
      if (domain) apiUrl.searchParams.set("domain", domain);

      const result = await fetchJsonRetry(apiUrl);
      const pageRows = result?.[bucketKey]?.field || [];
      rows.push(...pageRows);
      if (pageRows.length < 1000) break;
    }
    return rows;
  })();

  promise.catch(() => housingRowsCache.delete(cacheKey));
  putBoundedMap(housingRowsCache, cacheKey, promise, 2000);
  return promise;
}

function pickApartUnit(rows, { dong, ho, area }) {
  if (!ho) return null;

  const hoMatches = rows.filter((row) => unitTokenEquals(row.hoNm, ho));
  if (!hoMatches.length) return null;

  if (dong) {
    const dongMatches = hoMatches.filter((row) => unitTokenEquals(row.dongNm, dong));
    if (dongMatches.length) return closestByArea(dongMatches, area);
    // 주소의 동이 API 동 표기와 안 맞아도 해당 호수가 단지에 하나뿐이면 그 세대다.
    return hoMatches.length === 1 ? hoMatches[0] : null;
  }

  if (hoMatches.length === 1) return hoMatches[0];
  if (area) return closestByArea(hoMatches, area);

  // 동 정보 없이 같은 호수가 여러 동에 있으면, 가격이 전부 같을 때만 안전하게 채택한다.
  const prices = new Set(hoMatches.map((row) => String(row.pblntfPc)));
  return prices.size === 1 ? hoMatches[0] : null;
}

function closestByArea(rows, area) {
  if (rows.length === 1 || !area) return rows[0];
  return [...rows].sort((a, b) => Math.abs(numberFrom(a.prvuseAr) - area) - Math.abs(numberFrom(b.prvuseAr) - area))[0];
}

function normalizeUnitToken(value) {
  return String(value || "")
    .trim()
    .replace(/^제/, "")
    .replace(/(동|호)$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function unitTokenEquals(left, right) {
  const a = normalizeUnitToken(left);
  const b = normalizeUnitToken(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aDigits = a.replace(/\D/g, "");
  const bDigits = b.replace(/\D/g, "");
  return Boolean(aDigits) && aDigits === bDigits;
}

// "... 207동 16층1601호 (좌동, ...)" → { dong: "207", ho: "1601" }
// 법정동(좌동, 화곡동 등)과 건물동(가동, 101동)을 구분한다: 숫자동 우선, 한글동은 가~하 단일자만 인정.
export function parseUnitFromAddress(address) {
  const text = String(address || "").replace(/\[[^\]]*]/g, " ");

  let ho = "";
  const hoMatches = [...text.matchAll(/제?\s*(\d+)호/g)];
  if (hoMatches.length) ho = hoMatches[hoMatches.length - 1][1];

  let dong = "";
  const digitDongMatches = [...text.matchAll(/(?:^|[\s(])제?(\d+[A-Za-z]?)동(?=[^가-힣0-9]|$)/g)];
  if (digitDongMatches.length) {
    dong = digitDongMatches[digitDongMatches.length - 1][1];
  } else {
    const letterDongMatches = [...text.matchAll(/(?:^|\s)([가나다라마바사아자차카타파하])동(?=[^가-힣0-9]|$)/g)];
    if (letterDongMatches.length) dong = letterDongMatches[letterDongMatches.length - 1][1];
  }

  return { dong: normalizeUnitToken(dong), ho: normalizeUnitToken(ho) };
}

export async function fetchParcelBoundary(params) {
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

  const result = await fetchJsonRetry(apiUrl);
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

// 주소 → 정밀 좌표 + PNU. 같은 주소 반복 조회를 막기 위해 결과를 캐시한다.
const geocodeCache = new Map();

export async function fetchGeocode(params) {
  const address = cleanGeocodeAddress(params.get("address") || "");
  const serviceKey = process.env.VWORLD_API_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;

  if (!address) return { ok: false, error: "missing_address" };
  if (!serviceKey) {
    return {
      ok: false,
      error: "missing_key",
      message: ".env에 VWORLD_API_KEY를 넣으면 주소 지오코딩 API를 호출합니다."
    };
  }

  if (geocodeCache.has(address)) return geocodeCache.get(address);

  const point = await fetchVworldPoint(address);
  const payload = point
    ? { ok: true, found: true, address, lat: point.lat, lng: point.lng, pnu: point.pnu || "", category: point.geocodeCategory }
    : { ok: true, found: false, address };
  putBoundedMap(geocodeCache, address, payload, 20000);
  return payload;
}

export async function fetchVworldPoint(address) {
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
    const result = await fetchJsonRetry(apiUrl);
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

export function cleanGeocodeAddress(value) {
  return String(value || "")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*구조[^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function vworldDomain() {
  if (process.env.VWORLD_API_DOMAIN) return process.env.VWORLD_API_DOMAIN;
  // VERCEL_URL은 배포마다 바뀌는 일회성 주소(ggongji-map-abc123.vercel.app)라
  // VWorld에 등록해 둔 도메인과 영영 일치하지 않는다. 고정된 운영 도메인을 먼저 쓴다.
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.VERCEL ? "" : "http://127.0.0.1:4173";
}
