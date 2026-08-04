const LAND_PRICE_YEAR = new Date().getFullYear().toString();
const DEFAULT_DISCOUNT_FILTER = -100;
const REFERENCE_HYDRATION_LIMIT = 60;
const HYDRATION_MAX = 160;
const LIST_RENDER_LIMIT = 50;
const LIST_RENDER_STEP = 100;
const VIEWPORT_FETCH_MARGIN = 0.35;
const NAVER_MAP_SCRIPT_BASE = "https://oapi.map.naver.com/openapi/v3/maps.js";
const NAVER_MAP_MAX_RETRIES = 4;
const PROVINCE_CENTERS = {
  "서울특별시": [37.5665, 126.9780],
  "부산광역시": [35.1796, 129.0756],
  "대구광역시": [35.8714, 128.6014],
  "인천광역시": [37.4563, 126.7052],
  "광주광역시": [35.1595, 126.8526],
  "대전광역시": [36.3504, 127.3845],
  "울산광역시": [35.5384, 129.3114],
  "세종특별자치시": [36.4800, 127.2890],
  "경기도": [37.4138, 127.5183],
  "강원특별자치도": [37.8228, 128.1555],
  "충청북도": [36.8000, 127.7000],
  "충청남도": [36.5184, 126.8000],
  "전북특별자치도": [35.7175, 127.1530],
  "전라남도": [34.8679, 126.9910],
  "경상북도": [36.4919, 128.8889],
  "경상남도": [35.4606, 128.2132],
  "제주특별자치도": [33.4996, 126.5312]
};

let properties = [];
let naverMapsClientId = "";

const state = {
  selectedId: null,
  filters: {
    region: "all",
    type: "all",
    risk: "all",
    discount: DEFAULT_DISCOUNT_FILTER,
    sortBy: "score",
    keyword: ""
  },
  map: null,
  markers: new Map(),
  parcelPolygons: [],
  parcelLabelMarker: null,
  parcelBoundaryCache: new Map(),
  parcelBoundaryLoadingId: "",
  activeParcelPnu: "",
  naverLoaded: false,
  mapBoundsOnly: true,
  sidebarMode: "recommendations",
  hasUserMovedMap: false,
  isProgrammaticMove: false,
  mapBootTimer: null,
  viewportTimer: null,
  searchTimer: null,
  searchRequestId: 0,
  globalSearchIds: new Set(),
  viewportRequestId: 0,
  viewportLoading: false,
  viewportQueued: false,
  suppressNextIdleFetch: false,
  hydrating: false,
  hydrateQueued: null,
  loadedBounds: null,
  listLimit: LIST_RENDER_LIMIT,
  naverRetryCount: 0,
  naverRetryTimer: null,
  naverScriptLoading: false
};

const riskOrder = { 낮음: 1, 보통: 2, 높음: 3 };
const riskClass = { 낮음: "low", 보통: "mid", 높음: "high" };

const dom = {
  list: document.querySelector("#propertyList"),
  detail: document.querySelector("#detailPanel"),
  cardTemplate: document.querySelector("#propertyCardTemplate"),
  regionFilter: document.querySelector("#regionFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  riskFilter: document.querySelector("#riskFilter"),
  discountFilter: document.querySelector("#discountFilter"),
  discountValue: document.querySelector("#discountValue"),
  sortBy: document.querySelector("#sortBy"),
  keywordSearch: document.querySelector("#keywordSearch"),
  resetFilters: document.querySelector("#resetFilters"),
  fallbackMap: document.querySelector("#fallbackMap"),
  naverMap: document.querySelector("#naverMap"),
  dataStatus: document.querySelector("#dataStatus"),
  metricCount: document.querySelector("#metricCount"),
  metricAvgDiscount: document.querySelector("#metricAvgDiscount"),
  metricTopScore: document.querySelector("#metricTopScore")
};

window.navermap_authFailure = handleNaverAuthFailure;
init();

function init() {
  populateFilters();
  bindEvents();
  render();
  reloadNaverMapScript();
  hydrateExternalProperties();
}

async function hydrateExternalProperties() {
  setDataStatus("지도 화면 기준 로딩 대기", "sample");
  if (state.map) {
    loadViewportProperties({ force: true }).catch((error) => console.warn("Failed to load viewport properties", error));
  }
}

async function loadViewportProperties({ force = false } = {}) {
  if (!state.map || !window.naver || !window.naver.maps) return [];
  if (state.viewportLoading) {
    state.viewportQueued = true;
    return [];
  }

  const bounds = currentMapBounds();
  if (!bounds) return [];

  // 이미 불러온(여유분 포함) 영역 안에서의 이동/줌은 재요청 없이 클라이언트 필터로 처리한다.
  // 단, 새로 화면에 들어온 물건도 공시가격을 채워야 하므로 하이드레이션은 다시 조준한다.
  if (!force && state.loadedBounds && boundsContain(state.loadedBounds, bounds)) {
    triggerHydration("현재 화면 실데이터", "live");
    return properties;
  }

  // 화면보다 조금 넓게 받아 두면 이어지는 소규모 이동에서 재요청이 생략된다.
  const fetchBounds = expandBounds(bounds, VIEWPORT_FETCH_MARGIN);
  const requestId = state.viewportRequestId + 1;
  state.viewportRequestId = requestId;
  state.viewportLoading = true;
  setDataStatus("현재 지도 화면 경공매 조회 중", "live");

  try {
    const payload = await fetchViewportSource(fetchBounds, "court", { exactGeocode: "0" });
    if (requestId !== state.viewportRequestId) return [];

    const selectedBeforeReload = state.selectedId ? properties.find((item) => item.id === state.selectedId) : null;
    const incoming = applyHydrationCache(uniquePropertyItems(payload.properties || []));
    const withSearchResults = preserveGlobalSearchProperties(incoming, properties);
    properties = preserveSelectedProperty(withSearchResults, selectedBeforeReload);
    state.loadedBounds = fetchBounds;
    state.listLimit = LIST_RENDER_LIMIT;
    if (state.selectedId && !properties.some((item) => item.id === state.selectedId)) {
      state.selectedId = null;
      state.sidebarMode = "recommendations";
    }

    populateFilters();
    render();
    setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 법원경매 표시 · 온비드 확인 중`, "live");

    triggerHydration("현재 화면 실데이터", "live");

    loadOnbidViewportProperties(fetchBounds, requestId).catch((error) => console.warn("Failed to load viewport Onbid data", error));

    return incoming;
  } catch (error) {
    console.warn("Failed to load viewport properties", error);
    if (requestId === state.viewportRequestId) {
      state.loadedBounds = null;
      properties = [];
      state.selectedId = null;
      state.sidebarMode = "recommendations";
      populateFilters();
      render();
      setDataStatus("현재 화면 데이터 로드 실패", "sample");
    }
    return [];
  } finally {
    if (requestId === state.viewportRequestId) {
      state.viewportLoading = false;
      if (state.viewportQueued) {
        state.viewportQueued = false;
        window.setTimeout(() => loadViewportProperties({ force: true }), 40);
      }
    }
  }
}

function preserveSelectedProperty(items, selected) {
  if (!state.selectedId || !selected || items.some((item) => item.id === state.selectedId)) return items;
  return [selected, ...items];
}

function preserveGlobalSearchProperties(items, previousItems) {
  if (!state.globalSearchIds.size) return items;
  const searchResults = previousItems.filter((item) => state.globalSearchIds.has(item.id));
  return uniquePropertyItems([...searchResults, ...items]);
}

async function fetchViewportSource(bounds, source, options = {}) {
  const params = new URLSearchParams({
    swLat: String(bounds.swLat),
    swLng: String(bounds.swLng),
    neLat: String(bounds.neLat),
    neLng: String(bounds.neLng),
    sources: source,
    exactGeocode: options.exactGeocode || "1",
    zoom: String(state.map?.getZoom?.() || 0)
  });
  const response = await fetch(`/api/viewport-properties?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.message || payload.error || "viewport_error");
  return payload;
}

async function loadOnbidViewportProperties(bounds, requestId) {
  const payload = await fetchViewportSource(bounds, "onbid");
  if (requestId !== state.viewportRequestId) return [];

  const incoming = uniquePropertyItems(payload.properties || []);
  if (!incoming.length) {
    setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 화면 내 경공매`, "live");
    return [];
  }

  properties = uniquePropertyItems([...properties, ...applyHydrationCache(incoming)]);
  populateFilters();
  render();
  setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 화면 내 경공매 · 온비드 ${incoming.length}개`, "live");
  triggerHydration("현재 화면 실데이터", "live");
  return incoming;
}

function shouldHydrateReferenceData() {
  const zoom = state.map?.getZoom?.() || 0;
  return zoom >= 13;
}

// 하이드레이션은 "화면에 실제로 보이는" 물건(필터·정렬·경계 적용)을 조준한다.
// 로드 순서가 아니라 사용자가 리스트에서 보는 상위 물건이어야 체감 커버리지가 오른다.
function referenceHydrationTargets() {
  const enriched = properties.map(enrichProperty);
  const visible = getVisibleProperties(enriched);
  const limit = Math.min(Math.max(state.listLimit + 20, REFERENCE_HYDRATION_LIMIT), HYDRATION_MAX);
  return visible
    .filter((item) => item?.pnu || pnuGeocodeEligible(item) || item?.region?.startsWith("서울"))
    .slice(0, limit);
}

// 여러 트리거(뷰포트·온비드·더보기)가 겹쳐도 조회는 한 번에 하나씩만 돌린다.
function triggerHydration(baseLabel, tone) {
  if (!shouldHydrateReferenceData() || !properties.length) return;
  if (state.hydrating) {
    state.hydrateQueued = { baseLabel, tone };
    return;
  }
  state.hydrating = true;
  hydrateReferenceData(baseLabel, tone, referenceHydrationTargets())
    .catch((error) => console.warn("Failed to hydrate reference data", error))
    .finally(() => {
      state.hydrating = false;
      const queued = state.hydrateQueued;
      if (queued) {
        state.hydrateQueued = null;
        triggerHydration(queued.baseLabel, queued.tone);
      }
    });
}

function uniquePropertyItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// 하이드레이션으로 채운 값을 물건 id 기준으로 기억한다.
// 뷰포트 재로딩(properties = incoming)이 신선한 객체로 덮어써도 값이 사라지지 않게 한다.
const hydrationCache = new Map();
const HYDRATION_FIELDS = [
  "pnu",
  "lat",
  "lng",
  "geocodeSource",
  "publicLandPricePerSqm",
  "officialLandPriceSource",
  "officialLandPriceYear",
  "officialLandPricePublishedAt",
  "officialLandPriceLocation",
  "publicHousingPrice",
  "publicHousingPriceSource",
  "publicHousingPriceYear",
  "publicHousingPriceUnit",
  "publicStandardPrice",
  "publicStandardPriceSource",
  "publicStandardPriceUnit",
  "nearbyDeals",
  "marketDealSource",
  "marketDealScope"
];

function rememberHydration(item) {
  const patch = {};
  for (const key of HYDRATION_FIELDS) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "") patch[key] = value;
  }
  if (!Object.keys(patch).length) return;
  patch.checks = item.checks;

  // 오래 패닝하면 캐시가 무한히 자라므로 오래된 항목부터 밀어낸다.
  if (!hydrationCache.has(item.id) && hydrationCache.size >= 8000) {
    hydrationCache.delete(hydrationCache.keys().next().value);
  }
  hydrationCache.set(item.id, patch);
}

function applyHydrationCache(items) {
  if (!hydrationCache.size) return items;
  return items.map((item) => {
    const patch = hydrationCache.get(item.id);
    return patch ? { ...item, ...patch } : item;
  });
}

async function hydrateReferenceData(baseLabel, tone, targetItems = properties) {
  const pnuCount = await hydratePnu(baseLabel, tone, targetItems);
  // PNU가 새로 채워진 물건은 객체가 교체됐으므로 최신 객체로 이어서 공시가격을 조회한다.
  const refreshed = pnuCount ? refreshTargets(targetItems) : targetItems;
  const officialCount = await hydrateOfficialPrices(baseLabel, tone, refreshed);
  const dealCount = await hydrateSeoulDeals(baseLabel, tone, refreshed);
  const applied = [];

  if (pnuCount) applied.push(`지번확인 ${pnuCount}개`);
  if (officialCount) applied.push(`공시가격 ${officialCount}개`);
  if (dealCount) applied.push(`실거래 ${dealCount}개`);

  setDataStatus(applied.length ? `${baseLabel} · ${applied.join(" · ")} 반영` : `${baseLabel} ${properties.length}개`, tone);
}

function refreshTargets(items) {
  const current = new Map(properties.map((item) => [item.id, item]));
  return items.map((item) => current.get(item.id) || item);
}

// 지오코딩을 시도했지만 PNU를 못 찾은 물건은 다시 요청하지 않는다.
const geocodeMisses = new Set();

function pnuGeocodeEligible(item) {
  if (!item || item.pnu) return false;
  if (!(item.rawAddress || item.address)) return false;
  return ["land", "commonHousing", "detachedHousing", "officetel"].includes(officialPropertyKind(item));
}

async function hydratePnu(baseLabel, tone, targetItems = properties) {
  const candidates = targetItems.filter((item) => pnuGeocodeEligible(item) && !geocodeMisses.has(item.id));
  if (!candidates.length) return 0;

  setDataStatus(`${baseLabel} · 지번(PNU) 확인 중`, tone);

  const results = await mapWithConcurrency(candidates, 6, async (item) => {
      try {
        const url = `/api/geocode?address=${encodeURIComponent(item.rawAddress || item.address)}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return null;

        const payload = await response.json();
        if (!payload.ok || !payload.found || !payload.pnu) {
          if (payload.ok) geocodeMisses.add(item.id);
          return null;
        }

        return {
          ...item,
          pnu: payload.pnu,
          lat: payload.lat || item.lat,
          lng: payload.lng || item.lng,
          geocodeSource: "주소 좌표 확인",
          checks: uniqueValues([...(item.checks || []).filter((check) => check !== "주소 기반 추정 좌표"), "주소 좌표 확인"])
        };
      } catch (error) {
        console.warn("Failed to geocode", item.address, error);
        return null;
      }
    });

  const updates = new Map(results.filter(Boolean).map((item) => [item.id, item]));
  if (!updates.size) return 0;

  updates.forEach((item) => rememberHydration(item));
  properties = properties.map((item) => updates.get(item.id) || item);
  render();
  return updates.size;
}

// 조회했지만 매칭이 안 된 물건은 다시 요청하지 않는다. (viewport 갱신으로 객체가 바뀌어도 id 기준 유지)
const officialPriceMisses = new Set();

async function hydrateOfficialPrices(baseLabel, tone, targetItems = properties) {
  const candidates = targetItems.filter((item) => officialPriceRequest(item) && !officialPriceMisses.has(item.id));
  if (!candidates.length) return 0;

  setDataStatus(`${baseLabel} · 공시가격 조회 중`, tone);

  const results = await mapWithConcurrency(candidates, 8, async (item) => {
      const request = officialPriceRequest(item);
      try {
        const response = await fetch(request.url, { cache: "no-store" });
        if (!response.ok) return null;

        const payload = await response.json();
        const updated = request.apply(item, payload);
        if (!updated && payload.ok) officialPriceMisses.add(item.id);
        return updated;
      } catch (error) {
        console.warn("Failed to load official price", item.pnu, error);
        return null;
      }
    });

  const updates = new Map(results.filter(Boolean).map((item) => [item.id, item]));
  if (!updates.size) {
    return 0;
  }

  updates.forEach((item) => rememberHydration(item));
  properties = properties.map((item) => updates.get(item.id) || item);
  render();
  setDataStatus(`${baseLabel} · 공시가격 ${updates.size}개 반영`, tone);
  return updates.size;
}

// 물건 유형에 맞는 공시가격 API 요청을 만든다. 대상이 아니거나 이미 채워졌으면 null.
function officialPriceRequest(item) {
  if (numberFromValue(item.officialPrice) > 0) return null; // 사전 계산값이 있으면 조회 불필요
  if (!item.pnu) return null;
  const kind = officialPropertyKind(item);

  if (kind === "land") {
    if (item.officialLandPriceSource) return null;
    return {
      url: `/api/land-price?pnu=${encodeURIComponent(item.pnu)}&year=${encodeURIComponent(LAND_PRICE_YEAR)}`,
      apply: (target, payload) => {
        if (!payload.ok || !payload.pricePerSqm) return null;
        return {
          ...target,
          publicLandPricePerSqm: payload.pricePerSqm,
          officialLandPriceSource: payload.source,
          officialLandPriceYear: payload.year,
          officialLandPricePublishedAt: payload.publishedAt,
          officialLandPriceLocation: payload.landCodeName,
          checks: uniqueValues([...(target.checks || []), "토지공시지가 확인"])
        };
      }
    };
  }

  if (kind === "commonHousing" || kind === "detachedHousing") {
    if (numberFromValue(item.publicHousingPrice) > 0) return null;
    if (item.publicHousingPriceSource) return null;
    const params = new URLSearchParams({
      pnu: item.pnu,
      year: LAND_PRICE_YEAR,
      kind: kind === "commonHousing" ? "apart" : "indvd",
      address: item.rawAddress || item.address || ""
    });
    if (numberFromValue(item.buildingArea) > 0) params.set("area", String(item.buildingArea));
    return {
      url: `/api/housing-price?${params.toString()}`,
      apply: (target, payload) => {
        if (!payload.ok || !(payload.price > 0)) return null;
        return {
          ...target,
          publicHousingPrice: payload.price,
          publicHousingPriceSource: payload.source,
          publicHousingPriceYear: payload.year,
          publicHousingPriceUnit: payload.matched || null,
          checks: uniqueValues([...(target.checks || []), `${payload.source} 확인`])
        };
      }
    };
  }

  if (kind === "officetel") {
    if (numberFromValue(item.publicStandardPrice) > 0) return null;
    if (item.publicStandardPriceSource) return null;
    const params = new URLSearchParams({
      pnu: item.pnu,
      address: item.rawAddress || item.address || ""
    });
    return {
      url: `/api/officetel-price?${params.toString()}`,
      apply: (target, payload) => {
        if (!payload.ok || !(payload.price > 0)) return null;
        return {
          ...target,
          publicStandardPrice: payload.price,
          publicStandardPriceSource: payload.source,
          publicStandardPriceUnit: payload.matched || null,
          checks: uniqueValues([...(target.checks || []), `${payload.source} 확인`])
        };
      }
    };
  }

  return null;
}

async function hydrateSeoulDeals(baseLabel, tone, targetItems = properties) {
  const candidates = targetItems
    .map((item) => ({ item, addressParts: parseSeoulAddress(item.address) }))
    .filter(({ item, addressParts }) => addressParts && !item.marketDealSource);

  if (!candidates.length) return 0;

  setDataStatus(`${baseLabel} · 실거래가 조회 중`, tone);

  const results = await mapWithConcurrency(candidates, 4, async ({ item, addressParts }) => {
      try {
        const params = new URLSearchParams({
          district: addressParts.district,
          dong: addressParts.dong,
          type: item.type,
          limit: "3"
        });
        const response = await fetch(`/api/seoul-deals?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) return null;

        const payload = await response.json();
        if (!payload.ok || !payload.deals?.length) return null;

        return {
          ...item,
          nearbyDeals: payload.deals,
          marketDealSource: payload.source,
          marketDealScope: payload.scope,
          checks: uniqueValues([...(item.checks || []), "서울 실거래가"])
        };
      } catch (error) {
        console.warn("Failed to load Seoul deals", item.address, error);
        return null;
      }
    });

  const updates = new Map(results.filter(Boolean).map((item) => [item.id, item]));
  if (!updates.size) return 0;

  updates.forEach((item) => rememberHydration(item));
  properties = properties.map((item) => updates.get(item.id) || item);
  render();
  setDataStatus(`${baseLabel} · 실거래 ${updates.size}개 반영`, tone);
  return updates.size;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    results.push(...(await Promise.all(chunk.map(mapper))));
  }
  return results;
}

function parseSeoulAddress(address) {
  const parts = String(address || "").split(/\s+/).filter(Boolean);
  if (!parts.some((part) => part.includes("서울"))) return null;

  const district = parts.find((part) => part.endsWith("구")) || "";
  const dong = parts.find((part) => part.endsWith("동")) || "";

  if (!district) return null;
  return { district, dong };
}

function setDataStatus(text, tone) {
  if (!dom.dataStatus) return;
  dom.dataStatus.textContent = text;
  dom.dataStatus.classList.toggle("live", tone === "live");
  dom.dataStatus.classList.toggle("sample", tone === "sample");
}

function populateFilters() {
  const regions = ["all", ...new Set(properties.map((item) => item.region))];
  const types = ["all", ...new Set(properties.map((item) => item.type))];
  dom.regionFilter.innerHTML = regions.map((region) => option(region, region === "all" ? "전체" : region)).join("");
  dom.typeFilter.innerHTML = types.map((type) => option(type, type === "all" ? "전체" : type)).join("");
}

function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function bindEvents() {
  dom.regionFilter.addEventListener("change", (event) => updateFilter("region", event.target.value));
  dom.typeFilter.addEventListener("change", (event) => updateFilter("type", event.target.value));
  dom.riskFilter.addEventListener("change", (event) => updateFilter("risk", event.target.value));
  dom.sortBy.addEventListener("change", (event) => updateFilter("sortBy", event.target.value));
  dom.discountFilter.addEventListener("input", (event) => {
    updateFilter("discount", Number(event.target.value));
  });
  dom.keywordSearch.addEventListener("input", handleKeywordSearchInput);
  dom.resetFilters.addEventListener("click", resetFilters);
  document.addEventListener("click", (event) => {
    const marker = event.target.closest?.(".auction-marker[data-property-id], .dot-marker[data-property-id]");
    if (!marker) return;
    event.preventDefault();
    event.stopPropagation();
    openPropertyDetail(marker.dataset.propertyId);
  });
}

function handleKeywordSearchInput(event) {
  const query = event.target.value.trim();
  window.clearTimeout(state.searchTimer);
  state.searchRequestId += 1;
  state.globalSearchIds.clear();
  updateFilter("keyword", query);

  if (query.length < 2) return;
  const requestId = state.searchRequestId;
  state.searchTimer = window.setTimeout(() => {
    searchAllProperties(query, requestId).catch((error) => console.warn("Failed to search all properties", error));
  }, 300);
}

async function searchAllProperties(query, requestId) {
  setDataStatus("전체 매물에서 검색 중", "live");
  const params = new URLSearchParams({ q: query, limit: "20" });

  try {
    const response = await fetch(`/api/search-properties?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (requestId !== state.searchRequestId || state.filters.keyword !== query) return;
    if (!response.ok || !payload.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);

    const incoming = applyHydrationCache(uniquePropertyItems(payload.properties || []));
    state.globalSearchIds = new Set(incoming.map((item) => item.id));
    state.listLimit = LIST_RENDER_LIMIT;

    if (!incoming.length) {
      render();
      setDataStatus("전체 매물에서 검색 결과 없음", "sample");
      return;
    }

    properties = uniquePropertyItems([...incoming, ...properties]);
    if (incoming.length === 1) {
      openPropertyDetail(incoming[0].id);
      setDataStatus("전체 검색 결과 1개", "live");
    } else {
      state.selectedId = null;
      state.sidebarMode = "recommendations";
      render();
      setDataStatus(`전체 검색 결과 ${incoming.length.toLocaleString("ko-KR")}개 · 법원 확인 필요`, "live");
    }
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    console.warn("Failed to search all properties", error);
    setDataStatus("전체 매물 검색 실패", "sample");
  }
}

function updateFilter(key, value) {
  state.filters[key] = value;
  state.listLimit = LIST_RENDER_LIMIT;
  if (key === "discount") {
    dom.discountValue.textContent = formatDiscountFilter(value);
  }
  render();
}

function resetFilters() {
  state.filters = {
    region: "all",
    type: "all",
    risk: "all",
    discount: DEFAULT_DISCOUNT_FILTER,
    sortBy: "score",
    keyword: ""
  };
  state.selectedId = null;
  state.sidebarMode = "recommendations";
  window.clearTimeout(state.searchTimer);
  state.searchRequestId += 1;
  state.globalSearchIds.clear();
  state.listLimit = LIST_RENDER_LIMIT;
  dom.regionFilter.value = "all";
  dom.typeFilter.value = "all";
  dom.riskFilter.value = "all";
  dom.discountFilter.value = String(DEFAULT_DISCOUNT_FILTER);
  dom.discountValue.textContent = formatDiscountFilter(DEFAULT_DISCOUNT_FILTER);
  dom.sortBy.value = "score";
  dom.keywordSearch.value = "";
  render();
}

function render() {
  const enriched = properties.map(enrichProperty);
  const visible = getVisibleProperties(enriched);
  const mapItems = includeSelectedMapItem(visible, enriched);

  renderMetrics(visible);
  renderRecommendationPanel(visible);
  renderAuctionPanel(visible);
  renderMap(mapItems);
  renderSelectedParcelBoundary(enriched.find((item) => item.id === state.selectedId) || null);
}

function includeSelectedMapItem(items, enrichedItems) {
  if (!state.selectedId || items.some((item) => item.id === state.selectedId)) return items;
  const selected = enrichedItems.find((item) => item.id === state.selectedId);
  return selected ? [selected, ...items] : items;
}

function getVisibleProperties(items) {
  const filtered = items.filter(matchesFilters);
  const globalSearchItems = state.filters.keyword && state.globalSearchIds.size
    ? filtered.filter((item) => state.globalSearchIds.has(item.id))
    : [];
  if (globalSearchItems.length) return sortProperties(globalSearchItems);

  // 경계값은 한 번만 구해서 물건마다 숫자 비교만 한다. (물건당 SDK 호출 금지)
  const bounds = state.mapBoundsOnly && state.naverLoaded && state.map ? currentMapBounds() : null;
  const viewportItems = bounds
    ? filtered.filter(
        (item) =>
          item.lat >= bounds.swLat && item.lat <= bounds.neLat && item.lng >= bounds.swLng && item.lng <= bounds.neLng
      )
    : filtered;
  return sortProperties(viewportItems);
}

// 물건 객체가 교체되지 않는 한 점수 계산을 반복하지 않는다.
const enrichCache = new WeakMap();

function enrichProperty(item) {
  const cached = enrichCache.get(item);
  if (cached) return cached;

  const officialBasis = resolveOfficialBasis(item);
  const officialValue = officialBasis.value;
  const medianDeal = median(item.nearbyDeals.map((deal) => deal.pricePerSqm));
  const marketValue = medianDeal * comparableArea(item);
  const officialDiscount = officialBasis.comparable ? ratioDiscount(item.minBid, officialValue) : 0;
  const marketDiscount = ratioDiscount(item.minBid, marketValue);
  const failBonus = Math.min(item.failCount * 4, 12);
  const riskPenalty = riskOrder[item.risk] * 8;
  const officialWeight = officialBasis.comparable ? 55 : 0;
  const marketWeight = officialBasis.comparable ? 35 : 55;
  const basisPenalty = officialBasis.comparable ? 0 : 8;
  const score = Math.min(
    100,
    Math.max(0, Math.round(officialDiscount * officialWeight + marketDiscount * marketWeight + failBonus - riskPenalty - basisPenalty + 30))
  );

  const enriched = {
    ...item,
    officialValue,
    officialBasis,
    officialBasisLabel: officialBasis.label,
    officialBasisShortLabel: officialBasis.shortLabel,
    officialComparable: officialBasis.comparable,
    officialReferenceValue: officialBasis.referenceValue,
    officialReferenceLabel: officialBasis.referenceLabel,
    officialMissingLabel: officialBasis.missingLabel,
    marketValue,
    medianDeal,
    officialDiscount,
    marketDiscount,
    score
  };
  enrichCache.set(item, enriched);
  return enriched;
}

function resolveOfficialBasis(item) {
  const propertyKind = officialPropertyKind(item);
  const housingPrice = numberFromValue(item.publicHousingPrice);
  const standardPrice = numberFromValue(item.publicStandardPrice);
  const landReferenceValue = landOfficialValue(item);

  // 크롤러가 사전 계산해 실어 보낸 공시기준가가 있으면 그대로 쓴다(런타임 조회 불필요).
  const prebuilt = numberFromValue(item.officialPrice);
  if (prebuilt > 0) {
    const label = item.officialPriceType || "공시기준가";
    return {
      kind: propertyKind,
      label,
      shortLabel: label,
      value: prebuilt,
      comparable: true,
      referenceValue: landReferenceValue,
      referenceLabel: landReferenceValue ? "토지공시지가 참고" : ""
    };
  }

  if (standardPrice > 0) {
    return {
      kind: propertyKind,
      label: "기준시가",
      shortLabel: "기준시가",
      value: standardPrice,
      comparable: true,
      referenceValue: landReferenceValue,
      referenceLabel: landReferenceValue ? "토지공시지가 참고" : ""
    };
  }

  if (housingPrice > 0) {
    return {
      kind: propertyKind,
      label: propertyKind === "detachedHousing" ? "개별주택가격" : "공동주택가격",
      shortLabel: propertyKind === "detachedHousing" ? "주택공시가" : "공동주택가격",
      value: housingPrice,
      comparable: true,
      referenceValue: landReferenceValue,
      referenceLabel: landReferenceValue ? "토지공시지가 참고" : ""
    };
  }

  if (propertyKind === "land") {
    return {
      kind: "land",
      label: "개별공시지가 × 토지면적",
      shortLabel: "토지공시가",
      value: landReferenceValue,
      comparable: landReferenceValue > 0,
      referenceValue: 0,
      referenceLabel: "",
      missingLabel: "PNU/토지면적 필요"
    };
  }

  if (propertyKind === "commonHousing") {
    return officialMissingBasis("공동주택가격 필요", "공동주택가격 필요", landReferenceValue);
  }

  if (propertyKind === "officetel") {
    return officialMissingBasis("오피스텔 기준시가 필요", "기준시가 필요", landReferenceValue);
  }

  if (propertyKind === "detachedHousing") {
    return officialMissingBasis("개별주택가격 필요", "주택공시가 필요", landReferenceValue);
  }

  return officialMissingBasis("건물가치 포함 기준 필요", "기준가 필요", landReferenceValue);
}

function officialMissingBasis(label, shortLabel, referenceValue) {
  return {
    kind: "missing",
    label,
    shortLabel,
    value: 0,
    comparable: false,
    referenceValue,
    referenceLabel: referenceValue ? "토지공시지가 참고" : "",
    missingLabel: label
  };
}

function landOfficialValue(item) {
  const pricePerSqm = numberFromValue(item.publicLandPricePerSqm);
  const area = numberFromValue(item.landArea);
  return pricePerSqm > 0 && area > 0 ? pricePerSqm * area : 0;
}

function officialPropertyKind(item) {
  const text = `${item.type || ""} ${item.title || ""} ${item.category || ""} ${item.zoning || ""} ${item.address || ""}`;

  if (/(아파트|다세대|연립|공동주택|빌라)/.test(text)) return "commonHousing";
  if (/오피스텔/.test(text)) return "officetel";
  if (/(단독|다가구|주택)/.test(text)) return "detachedHousing";
  if (item.type === "토지" || /(임야|전|답|대지|잡종지|과수원|목장용지|공장용지|도로|하천|구거|체육용지)/.test(text)) {
    if (!/(건물|아파트|다세대|연립|빌라|주택|오피스텔|상가|공장|창고|근린)/.test(text)) return "land";
    if (item.type === "토지") return "land";
  }
  return "mixed";
}

function numberFromValue(value) {
  const number = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function comparableArea(item) {
  if (item.type === "토지") return item.landArea;
  if (item.type === "빌라") return 59;
  if (item.type === "오피스텔") return 28;
  return item.landArea;
}

function ratioDiscount(price, baseline) {
  if (!baseline) return 0;
  return (baseline - price) / baseline;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function matchesFilters(item) {
  const keyword = state.filters.keyword.toLowerCase();
  let matchesKeyword = true;
  if (keyword) {
    const text = item._searchText || (item._searchText = `${item.title} ${item.address} ${item.caseNo} ${item.memo}`.toLowerCase());
    const compactKeyword = compactSearchText(keyword);
    const compactText = item._compactSearchText || (item._compactSearchText = compactSearchText(text));
    matchesKeyword = text.includes(keyword) || compactText.includes(compactKeyword);
  }
  const riskLimit = state.filters.risk === "all" ? Infinity : riskOrder[state.filters.risk];
  const matchesDiscount =
    state.filters.discount <= DEFAULT_DISCOUNT_FILTER || (item.officialComparable && item.officialDiscount * 100 >= state.filters.discount);

  return (
    (state.filters.region === "all" || item.region === state.filters.region) &&
    (state.filters.type === "all" || item.type === state.filters.type) &&
    riskOrder[item.risk] <= riskLimit &&
    matchesDiscount &&
    matchesKeyword
  );
}

function compactSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-‐‑‒–—―·]/g, "");
}

function sortProperties(items) {
  return [...items].sort((a, b) => {
    if (state.filters.sortBy === "officialDiscount") {
      if (a.officialComparable !== b.officialComparable) return a.officialComparable ? -1 : 1;
      return b.officialDiscount - a.officialDiscount;
    }
    if (state.filters.sortBy === "marketDiscount") return b.marketDiscount - a.marketDiscount;
    if (state.filters.sortBy === "bidDate") return new Date(a.bidDate) - new Date(b.bidDate);
    return b.score - a.score;
  });
}

function renderMetrics(items) {
  // 화면 물건 수 · 공시가 비교 가능 수 · 7일 내 입찰 임박 수 — 실제 행동에 쓰는 카운트만 보여준다.
  const comparableCount = items.filter((item) => item.officialComparable).length;
  const imminentCount = items.filter((item) => {
    const dday = daysUntil(item.bidDate);
    return dday !== null && dday >= 0 && dday <= 7;
  }).length;
  dom.metricCount.textContent = items.length.toLocaleString("ko-KR");
  dom.metricAvgDiscount.textContent = comparableCount.toLocaleString("ko-KR");
  dom.metricTopScore.textContent = imminentCount.toLocaleString("ko-KR");
}

function daysUntil(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / 86400000);
}

function formatDday(value) {
  const days = daysUntil(value);
  if (days === null) return "미정";
  if (days < 0) return "기일지남";
  if (days === 0) return "오늘";
  return `D-${days}`;
}

function renderRecommendationPanel(items) {
  dom.list.innerHTML = "";

  if (state.sidebarMode === "detail") {
    const selectedRaw = properties.find((item) => item.id === state.selectedId);
    const selected = (selectedRaw && enrichProperty(selectedRaw)) || items[0];
    if (!selected) {
      state.sidebarMode = "recommendations";
    } else {
      renderInlineDetail(selected);
      return;
    }
  }

  dom.list.insertAdjacentHTML(
    "beforeend",
    `<div class="list-panel-header">
      <div>
        <strong>추천 물건</strong>
        <span>${state.filters.keyword && state.globalSearchIds.size ? "전체 매물 검색 결과" : "현재 지도 화면 기준"}</span>
      </div>
    </div>`
  );

  if (!items.length) {
    dom.list.insertAdjacentHTML("beforeend", `<p class="address">표시할 경공매 물건이 없습니다.</p>`);
    return;
  }

  const fragment = document.createDocumentFragment();
  const ordered = interleaveSourceItems(items);
  ordered.slice(0, state.listLimit).forEach((item) => {
    const node = dom.cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.classList.add(`source-${sourceKind(item)}`);
    node.classList.toggle("active", item.id === state.selectedId);
    const caseNode = node.querySelector(".case-no");
    caseNode.textContent = item.caseNo;
    caseNode.insertAdjacentHTML("afterbegin", sourceBadge(item));
    node.querySelector("h2").textContent = item.title;
    const dday = daysUntil(item.bidDate);
    const pill = node.querySelector(".score-pill");
    pill.textContent = formatDday(item.bidDate);
    pill.classList.toggle("urgent", dday !== null && dday >= 0 && dday <= 7);
    node.querySelector(".address").textContent = item.address;
    node.querySelector(".min-bid").textContent = formatWon(item.minBid);
    node.querySelector(".official-value").textContent = formatOfficialValue(item);
    node.querySelector(".official-discount").textContent = formatOfficialDiscount(item);
    node.querySelector(".official-discount").className = `official-discount ${officialDiscountTone(item)}`;
    node.querySelector(".bid-date").textContent = formatDate(item.bidDate);
    node.querySelector(".tag-row").innerHTML = renderTags(item);
    node.addEventListener("click", () => openPropertyDetail(item.id));
    fragment.append(node);
  });
  dom.list.append(fragment);
  appendLoadMoreButton(dom.list, ordered.length);
}

function appendLoadMoreButton(container, totalCount) {
  if (totalCount <= state.listLimit) return;
  const remaining = totalCount - state.listLimit;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "load-more";
  button.textContent = `더 보기 (${remaining.toLocaleString("ko-KR")}개 남음)`;
  button.addEventListener("click", () => {
    state.listLimit += LIST_RENDER_STEP;
    render();
    // 새로 펼쳐진 목록 물건도 공시가격 조회 대상에 포함한다.
    triggerHydration("목록 확장", "live");
  });
  container.append(button);
}

function renderAuctionPanel(items) {
  const sourceCounts = countSources(items);
  const scopeLabel = state.filters.keyword && state.globalSearchIds.size ? "전체 검색" : "현재 지도 화면 안";
  dom.detail.innerHTML = `
    <div class="list-panel-header">
      <div>
        <strong>경공매 물건</strong>
        <span>${scopeLabel} ${items.length}개 · 경매 ${sourceCounts.court} · 공매 ${sourceCounts.onbid}</span>
      </div>
    </div>
  `;

  if (!items.length) {
    dom.detail.insertAdjacentHTML("beforeend", `<p class="address">현재 지도 화면에 표시할 물건이 없습니다.</p>`);
    return;
  }

  const list = document.createElement("div");
  list.className = "compact-list";
  const ordered = interleaveSourceItems(items);
  ordered.slice(0, state.listLimit).forEach((item) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `compact-card source-${sourceKind(item)} ${item.id === state.selectedId ? "active" : ""}`;
    node.innerHTML = `
      <span class="case-no">${sourceBadge(item)}${escapeHtml(item.caseNo)}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <span>${formatWon(item.minBid)} · ${formatOfficialDiscount(item)} · ${formatDday(item.bidDate)}</span>
    `;
    node.addEventListener("click", () => openPropertyDetail(item.id));
    list.append(node);
  });
  appendLoadMoreButton(list, ordered.length);
  dom.detail.append(list);
}

function interleaveSourceItems(items) {
  const court = items.filter((item) => sourceKind(item) === "court");
  const onbid = items.filter((item) => sourceKind(item) === "onbid");
  if (!court.length || !onbid.length) return items;

  const result = [];
  const max = Math.max(court.length, onbid.length);
  for (let index = 0; index < max; index += 1) {
    if (court[index]) result.push(court[index]);
    if (onbid[index]) result.push(onbid[index]);
  }
  return result;
}

function countSources(items) {
  return items.reduce(
    (counts, item) => {
      counts[sourceKind(item)] += 1;
      return counts;
    },
    { court: 0, onbid: 0 }
  );
}

function openPropertyDetail(id) {
  state.sidebarMode = "detail";
  selectProperty(id);
}

function showRecommendationList() {
  state.sidebarMode = "recommendations";
  render();
}

function renderTags(item) {
  // 카드 제목(유형)·리스트 맥락(전부 경매)과 겹치는 태그는 빼고, 판단에 쓰는 3개 이내만 남긴다.
  const tags = [
    item.failCount >= 1
      ? { label: `유찰 ${item.failCount}회`, tone: item.failCount >= 2 ? "hot" : "" }
      : { label: "신건", tone: "info" },
    { label: `위험 ${item.risk}`, tone: item.risk === "낮음" ? "good" : item.risk === "높음" ? "hot" : "" }
  ];
  if (item.officialComparable) {
    tags.push({ label: `${item.officialBasisShortLabel} 기준`, tone: "good" });
  } else {
    tags.push({ label: "공시가 미확인", tone: "" });
  }
  return tags.map((tag) => `<span class="tag ${tag.tone}">${escapeHtml(tag.label)}</span>`).join("");
}

function selectProperty(id) {
  state.selectedId = id;
  render();
  const item = properties.find((property) => property.id === id);
  if (state.map && item) {
    state.isProgrammaticMove = true;
    state.suppressNextIdleFetch = true;
    state.map.panTo(new naver.maps.LatLng(item.lat, item.lng));
    window.setTimeout(() => {
      state.isProgrammaticMove = false;
    }, 900);
  }
  renderSelectedParcelBoundary(item);
  hydrateSelected(item);
}

// 지도 전체 마커는 대량이라 일괄 조회 상한을 넘어선다.
// 그래서 사용자가 실제로 클릭해서 보는 물건은 즉시(단건) 지오코딩→공시가격을 순차 조회해 비교보류를 없앤다.
// 일괄 파이프라인(refreshTargets/동시성)과 얽히지 않도록 자족적으로 처리한다.
async function hydrateSelected(item) {
  if (!item || !shouldHydrateReferenceData()) return;
  const id = item.id;
  const kind = officialPropertyKind(item);
  if (!["land", "commonHousing", "detachedHousing", "officetel"].includes(kind)) return;

  let current = properties.find((property) => property.id === id) || item;
  if (isOfficiallyPriced(current)) return;

  // 1) PNU가 없으면 먼저 지오코딩으로 확보한다.
  if (!current.pnu && pnuGeocodeEligible(current)) {
    try {
      const response = await fetch(`/api/geocode?address=${encodeURIComponent(current.rawAddress || current.address)}`, { cache: "no-store" });
      const payload = response.ok ? await response.json() : null;
      if (payload?.ok && payload.found && payload.pnu) {
        current = {
          ...current,
          pnu: payload.pnu,
          lat: payload.lat || current.lat,
          lng: payload.lng || current.lng,
          geocodeSource: "주소 좌표 확인",
          checks: uniqueValues([...(current.checks || []).filter((check) => check !== "주소 기반 추정 좌표"), "주소 좌표 확인"])
        };
        applySingleUpdate(current);
      } else if (payload?.ok) {
        geocodeMisses.add(id);
      }
    } catch (error) {
      console.warn("Failed to geocode selected property", error);
    }
  }
  if (!current.pnu) return;

  // 2) 유형에 맞는 공시가격/기준시가를 조회한다.
  const request = officialPriceRequest(current);
  if (!request) return;
  try {
    const response = await fetch(request.url, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const updated = request.apply(current, payload);
    if (updated) applySingleUpdate(updated);
    else if (payload.ok) officialPriceMisses.add(id);
  } catch (error) {
    console.warn("Failed to price selected property", error);
  }

  if (state.selectedId === id) render();
}

function isOfficiallyPriced(item) {
  return (
    numberFromValue(item.publicHousingPrice) > 0 ||
    numberFromValue(item.publicStandardPrice) > 0 ||
    Boolean(item.officialLandPriceSource)
  );
}

function applySingleUpdate(updated) {
  rememberHydration(updated);
  properties = properties.map((property) => (property.id === updated.id ? updated : property));
}

function renderMap(items) {
  if (state.naverLoaded && window.naver && window.naver.maps) {
    renderNaverMarkers(items);
    return;
  }
  renderFallbackMarkers(items);
}

function renderFallbackMarkers(items) {
  dom.fallbackMap.querySelectorAll(".fallback-marker").forEach((marker) => marker.remove());
  if (!items.length) return;

  const bounds = makeBounds(properties);
  items.forEach((item) => {
    const marker = document.createElement("button");
    marker.type = "button";
    const kind = sourceKind(item);
    marker.className = `fallback-marker source-${kind} ${item.score < 50 ? "risky" : item.score < 65 ? "medium" : ""}`;
    marker.classList.toggle("active", item.id === state.selectedId);
    marker.style.setProperty("--pin-color", markerColor(item, kind, false));
    marker.style.left = `${scale(item.lng, bounds.minLng, bounds.maxLng, 9, 91)}%`;
    marker.style.top = `${scale(item.lat, bounds.maxLat, bounds.minLat, 9, 91)}%`;
    marker.innerHTML = markerLabelHtml(item);
    marker.title = item.title;
    marker.addEventListener("click", () => openPropertyDetail(item.id));
    dom.fallbackMap.append(marker);
  });
}

function makeBounds(items) {
  if (!items.length) {
    return {
      minLat: 33,
      maxLat: 39,
      minLng: 124,
      maxLng: 132
    };
  }

  return {
    minLat: Math.min(...items.map((item) => item.lat)),
    maxLat: Math.max(...items.map((item) => item.lat)),
    minLng: Math.min(...items.map((item) => item.lng)),
    maxLng: Math.max(...items.map((item) => item.lng))
  };
}

function scale(value, min, max, outMin, outMax) {
  if (max === min) return (outMin + outMax) / 2;
  return ((value - min) / (max - min)) * (outMax - outMin) + outMin;
}

function bootMapWhenReady() {
  if (state.map) {
    if (!window.naver || !window.naver.maps) {
      resetNaverMapState();
      scheduleNaverMapRetry();
      return;
    }
    state.naverLoaded = true;
    dom.fallbackMap.hidden = true;
    dom.naverMap.hidden = false;
    naver.maps.Event.trigger(state.map, "resize");
    return;
  }

  if (window.naver && window.naver.maps) {
    if (state.mapBootTimer) {
      window.clearTimeout(state.mapBootTimer);
      state.mapBootTimer = null;
    }
    initNaverMap();
    return;
  }

  if (state.mapBootTimer) return;
  state.mapBootTimer = window.setTimeout(() => {
    state.mapBootTimer = null;
    bootMapWhenReady();
  }, 120);
}

function handleNaverAuthFailure() {
  resetNaverMapState();
  scheduleNaverMapRetry();
}

function resetNaverMapState() {
  state.map = null;
  state.naverLoaded = false;
  state.markers.forEach((marker) => marker.setMap?.(null));
  state.markers.clear();
  state.parcelPolygons.forEach((polygon) => polygon.setMap?.(null));
  state.parcelPolygons = [];
  state.parcelLabelMarker?.setMap?.(null);
  state.parcelLabelMarker = null;
  dom.naverMap.hidden = true;
  dom.naverMap.innerHTML = "";
  dom.fallbackMap.hidden = false;
}

function scheduleNaverMapRetry() {
  if (state.naverRetryCount >= NAVER_MAP_MAX_RETRIES || state.naverRetryTimer) return;

  const delay = 1200 * (state.naverRetryCount + 1);
  state.naverRetryCount += 1;
  state.naverRetryTimer = window.setTimeout(() => {
    state.naverRetryTimer = null;
    reloadNaverMapScript();
  }, delay);
}

async function reloadNaverMapScript() {
  if (window.naver?.maps) {
    bootMapWhenReady();
    return;
  }
  if (state.naverScriptLoading) return;

  state.naverScriptLoading = true;

  try {
    if (!naverMapsClientId) {
      const response = await fetch("/api/client-config", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok || !payload.naverMapsClientId) {
        throw new Error("NAVER_MAPS_CLIENT_ID is not configured");
      }
      naverMapsClientId = payload.naverMapsClientId;
    }
  } catch (error) {
    state.naverScriptLoading = false;
    setDataStatus("네이버 지도 설정 확인 필요", "sample");
    console.warn("Failed to load Naver Maps client config", error);
    scheduleNaverMapRetry();
    return;
  }

  document.querySelectorAll('script[src*="oapi.map.naver.com/openapi/v3/maps"]').forEach((script) => script.remove());
  document.querySelectorAll('script[src*="oapi.map.naver.com/openapi/v3/maps-geocoder"]').forEach((script) => script.remove());

  const script = document.createElement("script");
  const params = new URLSearchParams({
    ncpKeyId: naverMapsClientId,
    submodules: "geocoder",
    _retry: String(Date.now())
  });
  script.src = `${NAVER_MAP_SCRIPT_BASE}?${params.toString()}`;
  script.async = true;
  script.onload = () => {
    state.naverScriptLoading = false;
    bootMapWhenReady();
  };
  script.onerror = () => {
    state.naverScriptLoading = false;
    scheduleNaverMapRetry();
  };
  document.head.append(script);
}

function initNaverMap() {
  if (state.map) return;

  state.naverLoaded = true;
  dom.fallbackMap.hidden = true;
  dom.naverMap.hidden = false;
  const selected = properties.map(enrichProperty).find((item) => item.id === state.selectedId) || properties[0] || {
    lat: 37.5665,
    lng: 126.9780
  };
  state.map = new naver.maps.Map("naverMap", {
    center: new naver.maps.LatLng(selected.lat, selected.lng),
    zoom: 14,
    mapTypeId: naver.maps.MapTypeId.NORMAL,
    mapTypeControl: true,
    scaleControl: true,
    logoControl: true
  });
  naver.maps.Event.addListener(state.map, "dragstart", markUserMapInteraction);
  naver.maps.Event.addListener(state.map, "zoom_changed", markUserMapInteraction);
  naver.maps.Event.addListener(state.map, "idle", handleMapIdle);
  forceNaverRepaint(selected);
  render();
  window.setTimeout(validateNaverMapSession, 2800);
  window.setTimeout(() => {
    loadViewportProperties({ force: true }).catch((error) => console.warn("Failed to load initial viewport", error));
  }, 500);
}

function validateNaverMapSession() {
  if (!state.map) return;
  if (window.naver?.maps) {
    state.naverRetryCount = 0;
    return;
  }

  resetNaverMapState();
  scheduleNaverMapRetry();
}

function markUserMapInteraction() {
  if (!state.isProgrammaticMove) {
    state.hasUserMovedMap = true;
  }
}

function handleMapIdle() {
  window.clearTimeout(state.viewportTimer);
  state.viewportTimer = window.setTimeout(() => {
    render();
    if (state.suppressNextIdleFetch) {
      state.suppressNextIdleFetch = false;
      return;
    }
    if (state.filters.keyword && state.globalSearchIds.size) return;
    if (!state.isProgrammaticMove) {
      loadViewportProperties().catch((error) => console.warn("Failed to refresh viewport properties", error));
    }
  }, 260);
}

function currentMapBounds() {
  const bounds = state.map?.getBounds?.();
  if (!bounds) return null;

  const sw = bounds.getSW?.();
  const ne = bounds.getNE?.();
  if (!sw || !ne) return null;

  return {
    swLat: sw.lat(),
    swLng: sw.lng(),
    neLat: ne.lat(),
    neLng: ne.lng()
  };
}

function expandBounds(bounds, ratio) {
  const latPad = (bounds.neLat - bounds.swLat) * ratio;
  const lngPad = (bounds.neLng - bounds.swLng) * ratio;
  return {
    swLat: bounds.swLat - latPad,
    swLng: bounds.swLng - lngPad,
    neLat: bounds.neLat + latPad,
    neLng: bounds.neLng + lngPad
  };
}

function boundsContain(outer, inner) {
  return (
    inner.swLat >= outer.swLat &&
    inner.swLng >= outer.swLng &&
    inner.neLat <= outer.neLat &&
    inner.neLng <= outer.neLng
  );
}

function forceNaverRepaint(selected) {
  const repaint = () => {
    if (!state.map || !window.naver || !window.naver.maps) return;
    naver.maps.Event.trigger(state.map, "resize");
  };

  repaint();
  window.setTimeout(repaint, 200);
  window.setTimeout(repaint, 800);
  window.setTimeout(repaint, 1600);
}

function renderNaverMarkers(items) {
  const clusters = makeClusters(items);
  const visibleKeys = new Set(clusters.map((cluster) => cluster.key));

  state.markers.forEach((marker, key) => {
    if (!visibleKeys.has(key)) {
      marker.setMap(null);
      state.markers.delete(key);
    }
  });

  if (!clusters.length) return;

  clusters.forEach((cluster) => {
    const icon = markerIcon(cluster);
    let marker = state.markers.get(cluster.key);
    if (!marker) {
      marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(cluster.lat, cluster.lng),
        map: state.map,
        title: cluster.title,
        icon
      });
      // 클러스터 구성은 렌더마다 바뀔 수 있어 최신 상태를 marker에 실어 클릭 시 참조한다.
      naver.maps.Event.addListener(marker, "click", () => handleMarkerClick(marker.__cluster));
      state.markers.set(cluster.key, marker);
    } else {
      // 바뀐 것만 갱신한다. setIcon은 DOM 재생성이라 가장 비싸다.
      if (marker.__lat !== cluster.lat || marker.__lng !== cluster.lng) {
        marker.setPosition(new naver.maps.LatLng(cluster.lat, cluster.lng));
      }
      if (marker.__iconHtml !== icon.content) {
        marker.setIcon(icon);
      }
    }
    marker.__cluster = cluster;
    marker.__lat = cluster.lat;
    marker.__lng = cluster.lng;
    marker.__iconHtml = icon.content;
  });
}

function makeClusters(items) {
  if (!state.map || !window.naver || !window.naver.maps) return [];

  const zoom = state.map.getZoom();
  const adminLevel = adminClusterLevel(zoom);
  if (adminLevel) return makeAdminClusters(items, adminLevel);

  return makePropertyMarkers(items, zoom);
}

function makePropertyMarkers(items, zoom) {
  const sorted = sortProperties(items);
  const labelLimit = maxLabelMarkers(zoom);
  const labelItems = new Set(sorted.slice(0, labelLimit).map((item) => item.id));
  const clusters = makeCellClusters(sorted, clusterCellSize(zoom), labelItems, zoom);

  return limitDotMarkers(clusters, zoom);
}

function makeCellClusters(items, cellSize, labelItems, zoom) {
  const buckets = new Map();

  items.forEach((item) => {
    const key = `${Math.round(item.lat / cellSize)}:${Math.round(item.lng / cellSize)}`;
    const bucket = buckets.get(key) || [];
    bucket.push(item);
    buckets.set(key, bucket);
  });

  return [...buckets.entries()].map(([cellKey, bucket]) => {
    if (bucket.length === 1) {
      const item = bucket[0];
      return {
        ...item,
        key: `item:${item.id}`,
        count: 1,
        items: bucket,
        title: item.title,
        displayMode: labelItems.has(item.id) ? "label" : "dot"
      };
    }

    const lat = bucket.reduce((sum, item) => sum + item.lat, 0) / bucket.length;
    const lng = bucket.reduce((sum, item) => sum + item.lng, 0) / bucket.length;
    const top = sortProperties(bucket)[0];
    const displayMode = zoom >= 15 && labelItems.has(top.id) ? "label" : "dot";
    return {
      ...top,
      // 셀 좌표 기반 안정 키 — 데이터가 갱신돼도 같은 셀이면 마커를 재사용한다.
      key: `cell:${cellSize}:${cellKey}`,
      count: bucket.length,
      items: bucket,
      lat,
      lng,
      title: `${bucket.length}개 물건`,
      groupLabel: `${bucket.length}개`,
      displayMode
    };
  });
}

function adminClusterLevel(zoom) {
  if (zoom <= 8) return "province";
  if (zoom <= 11) return "district";
  if (zoom <= 13) return "local";
  return "";
}

function makeAdminClusters(items, level) {
  const buckets = new Map();

  items.forEach((item) => {
    const label = adminClusterLabel(item, level);
    const key = `${level}:${label}`;
    const bucket = buckets.get(key) || [];
    bucket.push(item);
    buckets.set(key, bucket);
  });

  const clusters = [...buckets.entries()].map(([key, bucket]) => {
    const top = sortProperties(bucket)[0];
    const label = key.split(":").slice(1).join(":");
    const center = level === "province" ? provinceCenter(label) : null;
    const lat = center?.[0] || bucket.reduce((sum, item) => sum + item.lat, 0) / bucket.length;
    const lng = center?.[1] || bucket.reduce((sum, item) => sum + item.lng, 0) / bucket.length;

    return {
      ...top,
      key: `admin:${key}`,
      count: bucket.length,
      items: bucket,
      lat,
      lng,
      title: `${label} ${bucket.length}개 물건`,
      groupLabel: shortAdminLabel(label),
      displayMode: "area",
      adminLabel: shortAdminLabel(label)
    };
  });

  return limitAdminClusters(clusters, level);
}

function adminClusterLabel(item, level) {
  const parts = String(item.address || item.region || guessRegion(item.address) || "전국")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "전국";

  const firstPartIsProvince = isKnownProvinceName(normalizeProvinceName(parts[0]));
  const province = resolveProvinceName(item, parts);
  const district = firstPartIsProvince ? parts[1] : parts[0];
  if (level === "province") return province;
  if (level === "district") return [province, district].filter(Boolean).join(" ");

  const local = findLocalAdminPart(parts.slice(firstPartIsProvince ? 2 : 1));
  return [province, district, local && local !== district ? local : ""].filter(Boolean).join(" ");
}

function resolveProvinceName(item, parts) {
  const direct = normalizeProvinceName(parts[0]);
  if (isKnownProvinceName(direct)) return direct;

  const found = parts.map(normalizeProvinceName).find(isKnownProvinceName);
  if (found) return found;

  const nearest = nearestProvinceByCoordinate(item);
  if (nearest) return nearest;

  return direct || "지역 미확인";
}

function isKnownProvinceName(value) {
  return Boolean(PROVINCE_CENTERS[value]);
}

function nearestProvinceByCoordinate(item) {
  const lat = Number(item?.lat);
  const lng = Number(item?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";

  return Object.entries(PROVINCE_CENTERS)
    .map(([label, center]) => ({
      label,
      distance: Math.hypot(lat - center[0], lng - center[1])
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.label || "";
}

function findLocalAdminPart(parts) {
  return (
    parts
      .map((part) => part.replace(/[(),]/g, "").trim())
      .find((part) => /(동|읍|면|리|가)$/.test(part) && !/(대로|로|길|번길)$/.test(part)) || ""
  );
}

function limitAdminClusters(clusters, level) {
  const max = level === "province" ? 40 : level === "district" ? 90 : 90;
  if (clusters.length <= max) return clusters;

  const selectedCluster = clusters.find((cluster) => cluster.items?.some((item) => item.id === state.selectedId));
  const ranked = clusters
    .filter((cluster) => cluster !== selectedCluster)
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.score || 0) - (a.score || 0))
    .slice(0, selectedCluster ? max - 1 : max);

  return selectedCluster ? [selectedCluster, ...ranked] : ranked;
}

function normalizeProvinceName(value) {
  const aliases = {
    서울: "서울특별시",
    서울시: "서울특별시",
    부산: "부산광역시",
    부산시: "부산광역시",
    대구: "대구광역시",
    대구시: "대구광역시",
    인천: "인천광역시",
    인천시: "인천광역시",
    광주: "광주광역시",
    광주시: "광주광역시",
    대전: "대전광역시",
    대전시: "대전광역시",
    울산: "울산광역시",
    울산시: "울산광역시",
    세종: "세종특별자치시",
    세종시: "세종특별자치시",
    경기: "경기도",
    강원: "강원특별자치도",
    강원도: "강원특별자치도",
    충북: "충청북도",
    충청북도: "충청북도",
    충남: "충청남도",
    충청남도: "충청남도",
    전북: "전북특별자치도",
    전라북도: "전북특별자치도",
    전남: "전라남도",
    전라남도: "전라남도",
    경북: "경상북도",
    경상북도: "경상북도",
    경남: "경상남도",
    경상남도: "경상남도",
    제주: "제주특별자치도",
    제주도: "제주특별자치도"
  };
  return aliases[value] || value;
}

function provinceCenter(label) {
  return PROVINCE_CENTERS[label] || null;
}

function shortAdminLabel(label) {
  return label
    .replace(/특별자치도|특별자치시|특별시|광역시|자치도/g, "")
    .replace(/청북도/g, "북")
    .replace(/청남도/g, "남")
    .replace(/라북도/g, "북")
    .replace(/라남도/g, "남")
    .replace(/상북도/g, "북")
    .replace(/상남도/g, "남");
}

function clusterCellSize(zoom) {
  if (zoom >= 18) return 0.00008;
  if (zoom >= 17) return 0.00018;
  if (zoom >= 16) return 0.00042;
  if (zoom >= 15) return 0.0009;
  return 0.0024;
}

function maxLabelMarkers(zoom) {
  if (zoom >= 18) return 140;
  if (zoom >= 17) return 110;
  if (zoom >= 16) return 76;
  if (zoom >= 15) return 44;
  return 22;
}

function maxDotMarkers(zoom) {
  if (zoom >= 18) return 260;
  if (zoom >= 17) return 220;
  if (zoom >= 16) return 180;
  if (zoom >= 15) return 130;
  return 90;
}

function limitDotMarkers(clusters, zoom) {
  const maxDots = maxDotMarkers(zoom);
  const labels = clusters.filter((cluster) => cluster.displayMode === "label");
  const dots = clusters.filter((cluster) => cluster.displayMode !== "label");
  if (dots.length <= maxDots) return clusters;

  const selectedDot = dots.find((cluster) => cluster.items?.some((item) => item.id === state.selectedId));
  const remaining = dots
    .filter((cluster) => cluster !== selectedDot)
    .sort((a, b) => (b.count || 1) - (a.count || 1) || (b.score || 0) - (a.score || 0))
    .slice(0, selectedDot ? maxDots - 1 : maxDots);

  return [...labels, ...(selectedDot ? [selectedDot] : []), ...remaining];
}

function handleMarkerClick(cluster) {
  if (cluster.count > 1 && state.map && cluster.displayMode !== "label") {
    state.isProgrammaticMove = true;
    state.map.setCenter(new naver.maps.LatLng(cluster.lat, cluster.lng));
    state.map.setZoom(Math.min(state.map.getZoom() + 2, 18));
    window.setTimeout(() => {
      state.isProgrammaticMove = false;
    }, 300);
    return;
  }

  openPropertyDetail(cluster.items[0].id);
}

async function renderSelectedParcelBoundary(item) {
  if (!state.map || !window.naver || !window.naver.maps) return;
  if (!item || !item.pnu) {
    clearParcelBoundary();
    return;
  }

  if (state.parcelBoundaryLoadingId === item.id) return;

  if (state.parcelBoundaryCache.has(item.pnu)) {
    drawParcelBoundary(item, state.parcelBoundaryCache.get(item.pnu));
    return;
  }

  state.parcelBoundaryLoadingId = item.id;
  try {
    const response = await fetch(`/api/parcel-boundary?pnu=${encodeURIComponent(item.pnu)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    if (!payload.ok || !payload.featureCollection?.features?.length) {
      state.parcelBoundaryCache.set(item.pnu, null);
      if (state.selectedId === item.id) clearParcelBoundary();
      return;
    }

    state.parcelBoundaryCache.set(item.pnu, payload.featureCollection);
    if (state.selectedId === item.id) drawParcelBoundary(item, payload.featureCollection);
  } catch (error) {
    console.warn("Failed to load parcel boundary", item.pnu, error);
    if (state.selectedId === item.id) clearParcelBoundary();
  } finally {
    state.parcelBoundaryLoadingId = "";
  }
}

function drawParcelBoundary(item, featureCollection) {
  if (state.activeParcelPnu === item.pnu && state.parcelPolygons.length) return;
  clearParcelBoundary();
  state.activeParcelPnu = item.pnu;
  if (!featureCollection) return;

  const rings = extractParcelRings(featureCollection);
  if (!rings.length) return;

  const bounds = new naver.maps.LatLngBounds(rings[0][0], rings[0][0]);
  rings.forEach((ring) => {
    ring.forEach((point) => bounds.extend(point));
    const polygon = new naver.maps.Polygon({
      map: state.map,
      paths: [ring],
      fillColor: "#4d8dff",
      fillOpacity: 0.36,
      strokeColor: "#007aff",
      strokeOpacity: 0.95,
      strokeWeight: 2,
      strokeStyle: "shortdash",
      zIndex: 120,
      clickable: false
    });
    state.parcelPolygons.push(polygon);
  });

  const center = bounds.getCenter();
  const content = `
    <div class="parcel-label">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${formatWon(item.minBid)} · ${formatOfficialDiscount(item)}</span>
    </div>
  `;

  state.parcelLabelMarker = new naver.maps.Marker({
    position: center,
    map: state.map,
    icon: {
      content,
      size: new naver.maps.Size(240, 56),
      anchor: new naver.maps.Point(120, 72)
    },
    clickable: false
  });
}

function clearParcelBoundary() {
  state.parcelPolygons.forEach((polygon) => polygon.setMap(null));
  state.parcelPolygons = [];
  state.activeParcelPnu = "";
  if (state.parcelLabelMarker) {
    state.parcelLabelMarker.setMap(null);
    state.parcelLabelMarker = null;
  }
}

function extractParcelRings(featureCollection) {
  const rings = [];
  (featureCollection.features || []).forEach((feature) => {
    const geometry = feature.geometry;
    if (!geometry) return;

    if (geometry.type === "Polygon") {
      const outerRing = geometry.coordinates?.[0] || [];
      const path = toNaverPath(outerRing);
      if (path.length) rings.push(path);
    }

    if (geometry.type === "MultiPolygon") {
      (geometry.coordinates || []).forEach((polygon) => {
        const outerRing = polygon?.[0] || [];
        const path = toNaverPath(outerRing);
        if (path.length) rings.push(path);
      });
    }
  });
  return rings;
}

function toNaverPath(coordinates) {
  return coordinates
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([lng, lat]) => new naver.maps.LatLng(lat, lng));
}

function markerIcon(item) {
  const isCluster = item.count > 1;
  const kind = isCluster ? clusterSourceKind(item.items || []) : sourceKind(item);
  const color = markerColor(item, kind, isCluster);
  const mode = item.displayMode || (isCluster ? "cluster" : "label");
  const active = item.items?.some((clusterItem) => clusterItem.id === state.selectedId) || item.id === state.selectedId;
  const content = markerContent(item, kind, color, mode, active);
  const markerSize = markerIconSize(item, mode);

  return {
    content,
    size: new naver.maps.Size(markerSize.width, markerSize.height),
    anchor: new naver.maps.Point(markerSize.anchorX, markerSize.anchorY)
  };
}

function markerContent(item, kind, color, mode, active) {
  if (mode === "area") {
    return `
      <div class="area-marker source-${kind}" style="--pin-color:${color};">
        <strong>${escapeHtml(item.adminLabel || item.groupLabel || "지역")}</strong>
        <span>${Number(item.count || 0).toLocaleString("ko-KR")}개</span>
        <i aria-hidden="true"></i>
      </div>
    `;
  }

  if (mode === "dot") {
    const representative = item.items?.[0] || item;
    const countLabel = item.count > 1 ? item.count.toLocaleString("ko-KR") : "";
    return `
      <div class="dot-marker source-${kind} ${active ? "active" : ""}" data-property-id="${escapeHtml(representative.id)}" style="--pin-color:${color};">
        <span>${escapeHtml(sourceShortLabel(representative))}</span>
        ${countLabel ? `<strong>${countLabel}</strong>` : ""}
      </div>
    `;
  }

  if (item.count > 1 && mode !== "label") {
    return `
      <div class="cluster-marker source-${kind}" style="--pin-color:${color};">
        <strong>${Number(item.count || 0).toLocaleString("ko-KR")}</strong>
        <span>${escapeHtml(item.groupLabel || "묶음")}</span>
        <i aria-hidden="true"></i>
      </div>
    `;
  }

  const representative = item.items?.[0] || item;
  return `
    <div class="auction-marker source-${kind} ${active ? "active" : ""}" data-property-id="${escapeHtml(representative.id)}" style="--pin-color:${color};">
      ${markerLabelHtml(representative)}
    </div>
  `;
}

function markerIconSize(item, mode) {
  if (mode === "area") {
    const width = Math.min(118, Math.max(78, 42 + String(item.adminLabel || item.groupLabel || "").length * 12));
    return { width, height: 54, anchorX: width / 2, anchorY: 62 };
  }
  if (mode === "dot") {
    const size = item.count > 1 ? 24 : 13;
    return { width: size, height: size, anchorX: size / 2, anchorY: size / 2 };
  }
  if (item.count > 1) {
    const width = Math.min(112, 68 + String(item.count).length * 10 + Math.log10(item.count + 1) * 7);
    return { width, height: 52, anchorX: width / 2, anchorY: 58 };
  }
  return { width: 96, height: 54, anchorX: 48, anchorY: 56 };
}

function markerColor(item, kind, isCluster) {
  if (isCluster && kind === "mixed") return "#64748b";
  if (kind === "onbid") return "#ff8352";
  if (kind === "court") return "#55b900";
  if (item.score < 50) return "#b4463e";
  if (item.score < 65) return "#9a6b00";
  return "#11845b";
}

function markerLabelHtml(item) {
  return `
    <span class="auction-marker-source">${escapeHtml(sourceShortLabel(item))}</span>
    <strong>${escapeHtml(formatMarkerBid(item.minBid))}</strong>
    <small>${escapeHtml(formatMarkerDate(item.bidDate))}</small>
    <i aria-hidden="true"></i>
  `;
}

function formatMarkerBid(value) {
  const amount = Number(value) || 0;
  if (!amount) return "가격 확인";
  if (Math.abs(amount) >= 100000000) return `${stripZero(amount / 100000000)}억`;
  if (Math.abs(amount) >= 10000) return `${Math.round(amount / 10000).toLocaleString("ko-KR")}만`;
  return formatWon(amount);
}

function formatMarkerDate(value) {
  const text = String(value || "").trim();
  if (!text) return "일정 확인";
  const normalized = text.replace(/[./년월]/g, "-").replace(/일/g, "");
  const match = normalized.match(/(?:\d{2,4}-)?(\d{1,2})-(\d{1,2})/);
  if (match) return `${Number(match[1])}.${String(Number(match[2])).padStart(2, "0")}`;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, "0")}`;
  return text.length > 6 ? text.slice(0, 6) : text;
}

function clusterSourceKind(items) {
  const kinds = new Set(items.map(sourceKind));
  if (kinds.size === 1) return [...kinds][0];
  return "mixed";
}

function sourceKind(item) {
  const source = String(item?.source || "");
  if (source.includes("온비드")) return "onbid";
  if (source.includes("법원")) return "court";
  return "court";
}

function sourceShortLabel(item) {
  return sourceKind(item) === "onbid" ? "공" : "경";
}

function sourceBadge(item) {
  return `<span class="source-badge ${sourceKind(item)}">${sourceShortLabel(item)}</span> `;
}

function renderInlineDetail(item) {
  if (!item) {
    dom.list.innerHTML = `<p class="address">선택된 물건이 없습니다.</p>`;
    return;
  }

  dom.list.innerHTML = `
    <div class="detail-nav">
      <button class="back-button" type="button" id="backToRecommendations">‹ 리스트</button>
      <span class="case-no">${escapeHtml(item.caseNo)}</span>
    </div>
    <section class="detail-header">
      <div class="risk-row">
        <span class="case-no">${sourceBadge(item)}${escapeHtml(item.caseNo)}</span>
        <span class="risk-badge ${riskClass[item.risk] || ""}">위험 ${escapeHtml(item.risk)}</span>
      </div>
      <h2>${escapeHtml(item.title)}</h2>
      <p class="detail-meta">${escapeHtml(item.address)}<br />입찰일 ${formatDate(item.bidDate)} · ${Number(item.failCount) || 0}회 유찰 · ${escapeHtml(item.zoning)}</p>
    </section>
    <section class="detail-grid" aria-label="상세 수치">
      ${detailStat("입찰까지", formatDday(item.bidDate))}
      ${detailStat("최저입찰가", formatWon(item.minBid))}
      ${detailStat("공시기준가", formatOfficialValue(item), item.officialComparable ? "" : "neutral")}
      ${detailStat("공시기준 대비", formatOfficialDiscount(item), officialDiscountTone(item))}
      ${item.marketValue > 0 ? detailStat("실거래 추정가", formatWon(item.marketValue)) : ""}
      ${item.marketValue > 0 ? detailStat("실거래 대비", formatSignedPercent(item.marketDiscount), item.marketDiscount >= 0 ? "positive" : "negative") : ""}
      ${item.officialReferenceValue ? detailStat(item.officialReferenceLabel || "토지공시지가 참고", formatWon(item.officialReferenceValue), "neutral") : ""}
      ${item.officialLandPriceSource ? detailStat("토지공시지가", `${item.officialLandPriceYear}년`) : ""}
      ${item.publicHousingPriceSource ? detailStat(item.publicHousingPriceSource, `${item.publicHousingPriceYear}년${item.publicHousingPriceUnit?.dong ? ` · ${item.publicHousingPriceUnit.dong}동` : ""}${item.publicHousingPriceUnit?.ho ? ` ${item.publicHousingPriceUnit.ho}호` : ""}`) : ""}
      ${item.publicStandardPriceSource ? detailStat(item.publicStandardPriceSource, `${item.publicStandardPriceUnit?.floor ? `${item.publicStandardPriceUnit.floor}층 ` : ""}${item.publicStandardPriceUnit?.ho ? `${item.publicStandardPriceUnit.ho}호` : ""}`.trim() || "확인") : ""}
    </section>
    <section class="detail-section">
      <h3>판단 메모</h3>
      <p class="address">${escapeHtml(item.memo)}</p>
      <div class="tag-row">${item.checks.map(displayCheckLabel).filter(Boolean).map((check) => `<span class="tag">${escapeHtml(check)}</span>`).join("")}</div>
    </section>
    <section class="detail-section">
      <h3>인근 실거래 참고</h3>
      <div class="deal-list">
        ${
          item.nearbyDeals.length
            ? item.nearbyDeals
                .map(
                  (deal) => `
            <div class="deal-row">
              <div>
                <strong>${escapeHtml(deal.label)}</strong><br />
                <span class="case-no">${escapeHtml(deal.date)}${formatDealMeta(deal)}</span>
              </div>
              <strong>${formatWon(deal.pricePerSqm)}/㎡</strong>
            </div>`
                )
                .join("")
            : `<p class="address">표시할 인근 실거래 데이터가 없습니다.</p>`
        }
      </div>
    </section>
    <div class="source-row">
      <span>데이터 출처</span>
      <strong>${escapeHtml(item.source)}</strong>
    </div>
  `;

  document.querySelector("#backToRecommendations")?.addEventListener("click", showRecommendationList);
}

function formatDealMeta(deal) {
  const parts = [];
  if (deal.distanceLabel) {
    parts.push(escapeHtml(deal.distanceLabel));
  } else if (Number(deal.distance) > 0) {
    parts.push(`${deal.distance}m`);
  }
  if (Number(deal.area) > 0) parts.push(`${stripZero(Number(deal.area))}㎡`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function detailStat(label, value, tone = "") {
  return `
    <div class="detail-stat">
      <span>${escapeHtml(label)}</span>
      <strong class="${tone}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function displayCheckLabel(value) {
  const text = String(value || "").trim();
  // 데이터 파이프라인 내부 사정(API 이름, 정규화 여부)은 사용자 판단에 무의미하므로 숨긴다.
  if (/^(법원경매 API|주소 정규화|온비드)$/.test(text)) return "";
  return text
    .replace(/VWorld\s*/gi, "")
    .replace(/주소검색/g, "주소 좌표 확인")
    .replace(/공시지가속성조회/g, "토지공시지가 확인")
    .replace(/공시지가 확인/g, "토지공시지가 확인")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatWon(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 100000000) {
    const eok = amount / 100000000;
    return `${stripZero(eok)}억`;
  }
  if (Math.abs(amount) >= 10000) {
    const man = amount / 10000;
    return `${Math.round(man).toLocaleString("ko-KR")}만`;
  }
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

function stripZero(value) {
  return value.toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  });
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatDiscountFilter(value) {
  return value <= DEFAULT_DISCOUNT_FILTER ? "전체" : `${value}%`;
}

function formatSignedPercent(value) {
  const sign = value > 0 ? "-" : "+";
  return `${sign}${Math.abs(Math.round(value * 100))}%`;
}

function formatOfficialValue(item) {
  return item.officialComparable ? formatWon(item.officialValue) : "기준 필요";
}

function formatOfficialDiscount(item) {
  return item.officialComparable ? formatSignedPercent(item.officialDiscount) : "비교 보류";
}

function officialDiscountTone(item) {
  if (!item.officialComparable) return "neutral";
  return item.officialDiscount >= 0 ? "positive" : "negative";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric"
  }).format(new Date(value));
}
