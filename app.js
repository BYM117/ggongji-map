const LAND_PRICE_YEAR = new Date().getFullYear().toString();
const DEFAULT_DISCOUNT_FILTER = -100;
const REFERENCE_HYDRATION_LIMIT = 60;
const NAVER_MAP_SCRIPT_BASE = "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=62klpb47yg&submodules=geocoder";
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
  viewportRequestId: 0,
  viewportLoading: false,
  viewportQueued: false,
  lastViewportKey: "",
  naverRetryCount: 0,
  naverRetryTimer: null
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
  bootMapWhenReady();
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

  const viewportKey = makeViewportKey(bounds);
  if (!force && viewportKey === state.lastViewportKey) return properties;

  const requestId = state.viewportRequestId + 1;
  state.viewportRequestId = requestId;
  state.viewportLoading = true;
  state.lastViewportKey = viewportKey;
  setDataStatus("현재 지도 화면 경공매 조회 중", "live");

  try {
    const payload = await fetchViewportSource(bounds, "court", { exactGeocode: "0" });
    if (requestId !== state.viewportRequestId) return [];

    const incoming = uniquePropertyItems(payload.properties || []);
    properties = incoming;
    if (state.selectedId && !properties.some((item) => item.id === state.selectedId)) {
      state.selectedId = null;
      state.sidebarMode = "recommendations";
    }

    populateFilters();
    render();
    setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 법원경매 표시 · 온비드 확인 중`, "live");

    if (shouldHydrateReferenceData() && properties.length) {
      hydrateReferenceData("현재 화면 실데이터", "live", referenceHydrationTargets(properties))
        .catch((error) => console.warn("Failed to hydrate viewport reference data", error));
    }

    loadOnbidViewportProperties(bounds, requestId).catch((error) => console.warn("Failed to load viewport Onbid data", error));

    return incoming;
  } catch (error) {
    console.warn("Failed to load viewport properties", error);
    if (requestId === state.viewportRequestId) {
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

async function loadExactCourtViewportProperties(bounds, requestId) {
  const payload = await fetchViewportSource(bounds, "court", { exactGeocode: "1" });
  if (requestId !== state.viewportRequestId) return [];

  const incoming = uniquePropertyItems(payload.properties || []);
  if (!incoming.length) return [];

  properties = mergePropertyUpdates(properties, incoming);
  populateFilters();
  render();
  setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 화면 내 경공매 · 정밀 좌표 반영`, "live");
  if (shouldHydrateReferenceData()) {
    hydrateReferenceData("현재 화면 실데이터", "live", referenceHydrationTargets(incoming))
    .catch((error) => console.warn("Failed to hydrate exact court reference data", error));
  }
  return incoming;
}

async function loadOnbidViewportProperties(bounds, requestId) {
  const payload = await fetchViewportSource(bounds, "onbid");
  if (requestId !== state.viewportRequestId) return [];

  const incoming = uniquePropertyItems(payload.properties || []);
  if (!incoming.length) {
    setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 화면 내 경공매`, "live");
    return [];
  }

  properties = uniquePropertyItems([...properties, ...incoming]);
  populateFilters();
  render();
  setDataStatus(`${properties.length.toLocaleString("ko-KR")}개 화면 내 경공매 · 온비드 ${incoming.length}개`, "live");
  if (shouldHydrateReferenceData()) {
    hydrateReferenceData("현재 화면 실데이터", "live", referenceHydrationTargets(incoming))
    .catch((error) => console.warn("Failed to hydrate Onbid reference data", error));
  }
  return incoming;
}

function shouldHydrateReferenceData() {
  const zoom = state.map?.getZoom?.() || 0;
  return zoom >= 13;
}

function referenceHydrationTargets(items) {
  return interleaveSourceItems(items)
    .filter((item) => item?.pnu || item?.region?.startsWith("서울"))
    .slice(0, REFERENCE_HYDRATION_LIMIT);
}

function mergePropertyUpdates(currentItems, updates) {
  const updateMap = new Map(updates.map((item) => [item.id, item]));
  const merged = currentItems.map((item) => updateMap.get(item.id) || item);
  const currentIds = new Set(merged.map((item) => item.id));
  updates.forEach((item) => {
    if (!currentIds.has(item.id)) merged.push(item);
  });
  return merged;
}

function uniquePropertyItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function hydrateReferenceData(baseLabel, tone, targetItems = properties) {
  const officialCount = await hydrateOfficialLandPrices(baseLabel, tone, targetItems);
  const dealCount = await hydrateSeoulDeals(baseLabel, tone, targetItems);
  const applied = [];

  if (officialCount) applied.push(`공시지가 ${officialCount}개`);
  if (dealCount) applied.push(`실거래 ${dealCount}개`);

  setDataStatus(applied.length ? `${baseLabel} · ${applied.join(" · ")} 반영` : `${baseLabel} ${properties.length}개`, tone);
}

async function hydrateOfficialLandPrices(baseLabel, tone, targetItems = properties) {
  const candidates = targetItems.filter((item) => item.pnu && !item.officialLandPriceSource);
  if (!candidates.length) return 0;

  setDataStatus(`${baseLabel} · 공시지가 조회 중`, tone);

  const results = await mapWithConcurrency(candidates, 8, async (item) => {
      try {
        const url = `/api/land-price?pnu=${encodeURIComponent(item.pnu)}&year=${encodeURIComponent(LAND_PRICE_YEAR)}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return null;

        const payload = await response.json();
        if (!payload.ok || !payload.pricePerSqm) return null;

        return {
          ...item,
          publicLandPricePerSqm: payload.pricePerSqm,
          officialLandPriceSource: payload.source,
          officialLandPriceYear: payload.year,
          officialLandPricePublishedAt: payload.publishedAt,
          officialLandPriceLocation: payload.landCodeName,
          checks: uniqueValues([...(item.checks || []), "공시지가 확인"])
        };
      } catch (error) {
        console.warn("Failed to load official land price", item.pnu, error);
        return null;
      }
    });

  const updates = new Map(results.filter(Boolean).map((item) => [item.id, item]));
  if (!updates.size) {
    return 0;
  }

  properties = properties.map((item) => updates.get(item.id) || item);
  render();
  setDataStatus(`${baseLabel} · 공시지가 ${updates.size}개 반영`, tone);
  return updates.size;
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
  return `<option value="${value}">${label}</option>`;
}

function bindEvents() {
  dom.regionFilter.addEventListener("change", (event) => updateFilter("region", event.target.value));
  dom.typeFilter.addEventListener("change", (event) => updateFilter("type", event.target.value));
  dom.riskFilter.addEventListener("change", (event) => updateFilter("risk", event.target.value));
  dom.sortBy.addEventListener("change", (event) => updateFilter("sortBy", event.target.value));
  dom.discountFilter.addEventListener("input", (event) => {
    updateFilter("discount", Number(event.target.value));
  });
  dom.keywordSearch.addEventListener("input", (event) => updateFilter("keyword", event.target.value.trim()));
  dom.resetFilters.addEventListener("click", resetFilters);
}

function updateFilter(key, value) {
  state.filters[key] = value;
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

  renderMetrics(visible);
  renderRecommendationPanel(visible);
  renderAuctionPanel(visible);
  renderMap(visible);
  renderSelectedParcelBoundary(enriched.find((item) => item.id === state.selectedId) || null);
}

function getVisibleProperties(items) {
  const filtered = items.filter(matchesFilters);
  const viewportItems = state.mapBoundsOnly && state.naverLoaded && state.map
    ? filtered.filter(isInsideMapBounds)
    : filtered;
  return sortProperties(viewportItems);
}

function enrichProperty(item) {
  const officialValue = item.publicHousingPrice || item.publicLandPricePerSqm * item.landArea;
  const medianDeal = median(item.nearbyDeals.map((deal) => deal.pricePerSqm));
  const marketValue = medianDeal * comparableArea(item);
  const officialDiscount = ratioDiscount(item.minBid, officialValue);
  const marketDiscount = ratioDiscount(item.minBid, marketValue);
  const failBonus = Math.min(item.failCount * 4, 12);
  const riskPenalty = riskOrder[item.risk] * 8;
  const score = Math.min(100, Math.max(0, Math.round(officialDiscount * 55 + marketDiscount * 35 + failBonus - riskPenalty + 30)));

  return {
    ...item,
    officialValue,
    marketValue,
    medianDeal,
    officialDiscount,
    marketDiscount,
    score
  };
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
  const text = `${item.title} ${item.address} ${item.caseNo} ${item.memo}`.toLowerCase();
  const riskLimit = state.filters.risk === "all" ? Infinity : riskOrder[state.filters.risk];
  const matchesDiscount =
    state.filters.discount <= DEFAULT_DISCOUNT_FILTER || item.officialDiscount * 100 >= state.filters.discount;

  return (
    (state.filters.region === "all" || item.region === state.filters.region) &&
    (state.filters.type === "all" || item.type === state.filters.type) &&
    riskOrder[item.risk] <= riskLimit &&
    matchesDiscount &&
    (!keyword || text.includes(keyword))
  );
}

function sortProperties(items) {
  return [...items].sort((a, b) => {
    if (state.filters.sortBy === "officialDiscount") return b.officialDiscount - a.officialDiscount;
    if (state.filters.sortBy === "marketDiscount") return b.marketDiscount - a.marketDiscount;
    if (state.filters.sortBy === "bidDate") return new Date(a.bidDate) - new Date(b.bidDate);
    return b.score - a.score;
  });
}

function renderMetrics(items) {
  const avgDiscount = items.length
    ? items.reduce((sum, item) => sum + item.officialDiscount, 0) / items.length
    : 0;
  const topScore = items.length ? Math.max(...items.map((item) => item.score)) : 0;
  dom.metricCount.textContent = String(items.length);
  dom.metricAvgDiscount.textContent = formatPercent(avgDiscount);
  dom.metricTopScore.textContent = String(topScore);
}

function renderRecommendationPanel(items) {
  dom.list.innerHTML = "";

  if (state.sidebarMode === "detail") {
    const selected = properties.map(enrichProperty).find((item) => item.id === state.selectedId) || items[0];
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
        <span>현재 지도 화면 기준</span>
      </div>
    </div>`
  );

  if (!items.length) {
    dom.list.insertAdjacentHTML("beforeend", `<p class="address">표시할 경공매 물건이 없습니다.</p>`);
    return;
  }

  const fragment = document.createDocumentFragment();
  interleaveSourceItems(items).forEach((item) => {
    const node = dom.cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.classList.add(`source-${sourceKind(item)}`);
    node.classList.toggle("active", item.id === state.selectedId);
    const caseNode = node.querySelector(".case-no");
    caseNode.textContent = item.caseNo;
    caseNode.insertAdjacentHTML("afterbegin", sourceBadge(item));
    node.querySelector("h2").textContent = item.title;
    node.querySelector(".score-pill").textContent = `${item.score}점`;
    node.querySelector(".address").textContent = item.address;
    node.querySelector(".min-bid").textContent = formatWon(item.minBid);
    node.querySelector(".official-value").textContent = formatWon(item.officialValue);
    node.querySelector(".official-discount").textContent = formatSignedPercent(item.officialDiscount);
    node.querySelector(".official-discount").className = `official-discount ${item.officialDiscount >= 0 ? "positive" : "negative"}`;
    node.querySelector(".market-discount").textContent = formatSignedPercent(item.marketDiscount);
    node.querySelector(".market-discount").className = `market-discount ${item.marketDiscount >= 0 ? "positive" : "negative"}`;
    node.querySelector(".tag-row").innerHTML = renderTags(item);
    node.addEventListener("click", () => openPropertyDetail(item.id));
    fragment.append(node);
  });
  dom.list.append(fragment);
}

function renderAuctionPanel(items) {
  const sourceCounts = countSources(items);
  dom.detail.innerHTML = `
    <div class="list-panel-header">
      <div>
        <strong>경공매 물건</strong>
        <span>현재 지도 화면 안 ${items.length}개 · 경매 ${sourceCounts.court} · 공매 ${sourceCounts.onbid}</span>
      </div>
    </div>
  `;

  if (!items.length) {
    dom.detail.insertAdjacentHTML("beforeend", `<p class="address">현재 지도 화면에 표시할 물건이 없습니다.</p>`);
    return;
  }

  const list = document.createElement("div");
  list.className = "compact-list";
  interleaveSourceItems(items).forEach((item) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `compact-card source-${sourceKind(item)} ${item.id === state.selectedId ? "active" : ""}`;
    node.innerHTML = `
      <span class="case-no">${sourceBadge(item)}${item.caseNo}</span>
      <strong>${item.title}</strong>
      <span>${formatWon(item.minBid)} · ${formatSignedPercent(item.officialDiscount)} · ${item.type}</span>
    `;
    node.addEventListener("click", () => openPropertyDetail(item.id));
    list.append(node);
  });
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
  const tags = [
    { label: sourceLabel(item), tone: sourceKind(item) },
    { label: item.type, tone: "info" },
    { label: `${item.failCount}회 유찰`, tone: item.failCount >= 2 ? "hot" : "" },
    { label: `위험 ${item.risk}`, tone: item.risk === "낮음" ? "good" : item.risk === "높음" ? "hot" : "" },
    { label: item.zoning, tone: "" }
  ];
  if (item.officialLandPriceSource) {
    tags.push({ label: "공시지가 확인", tone: "good" });
  }
  if (item.marketDealSource) {
    tags.push({ label: "서울 실거래가", tone: "info" });
  }
  return tags.map((tag) => `<span class="tag ${tag.tone}">${tag.label}</span>`).join("");
}

function selectProperty(id) {
  state.selectedId = id;
  render();
  const item = properties.find((property) => property.id === id);
  if (state.map && item) {
    state.isProgrammaticMove = true;
    state.map.panTo(new naver.maps.LatLng(item.lat, item.lng));
    window.setTimeout(() => {
      state.isProgrammaticMove = false;
    }, 300);
  }
  renderSelectedParcelBoundary(item);
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
    marker.className = `fallback-marker ${item.score < 50 ? "risky" : item.score < 65 ? "medium" : ""}`;
    marker.classList.toggle("active", item.id === state.selectedId);
    marker.style.left = `${scale(item.lng, bounds.minLng, bounds.maxLng, 9, 91)}%`;
    marker.style.top = `${scale(item.lat, bounds.maxLat, bounds.minLat, 9, 91)}%`;
    marker.textContent = `${item.score}`;
    marker.title = item.title;
    marker.addEventListener("click", () => selectProperty(item.id));
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

function reloadNaverMapScript() {
  if (window.naver?.maps) {
    bootMapWhenReady();
    return;
  }

  document.querySelectorAll('script[src*="oapi.map.naver.com/openapi/v3/maps"]').forEach((script) => script.remove());
  document.querySelectorAll('script[src*="oapi.map.naver.com/openapi/v3/maps-geocoder"]').forEach((script) => script.remove());

  const script = document.createElement("script");
  script.src = `${NAVER_MAP_SCRIPT_BASE}&_retry=${Date.now()}`;
  script.async = true;
  script.onload = () => bootMapWhenReady();
  script.onerror = () => scheduleNaverMapRetry();
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

function makeViewportKey(bounds) {
  const zoom = state.map?.getZoom?.() || 0;
  const precision = zoom >= 15 ? 3 : zoom >= 12 ? 2 : 1;
  return [bounds.swLat, bounds.swLng, bounds.neLat, bounds.neLng]
    .map((value) => Number(value).toFixed(precision))
    .join(":");
}

function isInsideMapBounds(item) {
  if (!state.map || !window.naver || !window.naver.maps) return true;
  const bounds = state.map.getBounds();
  if (!bounds) return true;

  const point = new naver.maps.LatLng(item.lat, item.lng);
  if (typeof bounds.hasLatLng === "function") return bounds.hasLatLng(point);

  const sw = bounds.getSW?.();
  const ne = bounds.getNE?.();
  if (!sw || !ne) return true;

  const lat = item.lat;
  const lng = item.lng;
  return lat >= sw.lat() && lat <= ne.lat() && lng >= sw.lng() && lng <= ne.lng();
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
    let marker = state.markers.get(cluster.key);
    if (!marker) {
      marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(cluster.lat, cluster.lng),
        map: state.map,
        title: cluster.title,
        icon: markerIcon(cluster)
      });
      naver.maps.Event.addListener(marker, "click", () => handleMarkerClick(cluster));
      state.markers.set(cluster.key, marker);
    }
    marker.setPosition(new naver.maps.LatLng(cluster.lat, cluster.lng));
    marker.setIcon(markerIcon(cluster));
  });
}

function makeClusters(items) {
  if (!state.map || !window.naver || !window.naver.maps) return [];

  const zoom = state.map.getZoom();
  const adminLevel = adminClusterLevel(zoom);
  if (adminLevel) return makeAdminClusters(items, adminLevel);

  const cellSize = clusterCellSize(zoom);
  const buckets = new Map();

  items.forEach((item) => {
    const key = `${Math.round(item.lat / cellSize)}:${Math.round(item.lng / cellSize)}`;
    const bucket = buckets.get(key) || [];
    bucket.push(item);
    buckets.set(key, bucket);
  });

  return [...buckets.values()].map((bucket) => {
    if (bucket.length === 1) {
      const item = bucket[0];
      return {
        ...item,
        key: `item:${item.id}`,
        count: 1,
        items: bucket,
        title: item.title
      };
    }

    const lat = bucket.reduce((sum, item) => sum + item.lat, 0) / bucket.length;
    const lng = bucket.reduce((sum, item) => sum + item.lng, 0) / bucket.length;
    const top = sortProperties(bucket)[0];
    return {
      ...top,
      key: `cluster:${bucket.map((item) => item.id).sort().join("|")}`,
      count: bucket.length,
      items: bucket,
      lat,
      lng,
      title: `${bucket.length}개 물건`,
      groupLabel: ""
    };
  });
}

function adminClusterLevel(zoom) {
  if (zoom <= 7) return "province";
  if (zoom <= 10) return "district";
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

  return [...buckets.entries()].map(([key, bucket]) => {
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
      groupLabel: shortAdminLabel(label)
    };
  });
}

function adminClusterLabel(item, level) {
  const parts = String(item.region || guessRegion(item.address) || "전국")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "전국";

  const province = normalizeProvinceName(parts[0]);
  if (level === "province") return province;
  return [province, parts[1]].filter(Boolean).join(" ");
}

function normalizeProvinceName(value) {
  const aliases = {
    서울: "서울특별시",
    부산: "부산광역시",
    대구: "대구광역시",
    인천: "인천광역시",
    광주: "광주광역시",
    대전: "대전광역시",
    울산: "울산광역시",
    세종: "세종특별자치시",
    경기: "경기도",
    강원: "강원특별자치도",
    충북: "충청북도",
    충남: "충청남도",
    전북: "전북특별자치도",
    전남: "전라남도",
    경북: "경상북도",
    경남: "경상남도",
    제주: "제주특별자치도"
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
  if (zoom >= 16) return 0.0015;
  if (zoom >= 14) return 0.004;
  if (zoom >= 12) return 0.012;
  if (zoom >= 10) return 0.035;
  if (zoom >= 8) return 0.08;
  return 0.16;
}

function handleMarkerClick(cluster) {
  if (cluster.count > 1 && state.map) {
    state.isProgrammaticMove = true;
    state.map.setCenter(new naver.maps.LatLng(cluster.lat, cluster.lng));
    state.map.setZoom(Math.min(state.map.getZoom() + 2, 18));
    window.setTimeout(() => {
      state.isProgrammaticMove = false;
    }, 300);
    return;
  }

  selectProperty(cluster.items[0].id);
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
      <strong>${item.title}</strong>
      <span>${formatWon(item.minBid)} · ${formatSignedPercent(item.officialDiscount)}</span>
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
  const size = isCluster ? Math.min(68, 40 + Math.log10(item.count + 1) * 13) : 46;
  const label = isCluster ? item.count : item.score;
  const className = isCluster
    ? `cluster-marker source-${kind}`
    : `pinpoint-marker source-${kind} ${item.id === state.selectedId ? "active" : ""}`;
  const content = isCluster
    ? `<div class="${className}" style="width:${size}px;height:${size}px;background:${color};"><strong>${label}</strong>${item.groupLabel ? `<span>${item.groupLabel}</span>` : ""}</div>`
    : `<div class="${className}" style="--pin-color:${color};"><span class="pin-reticle"></span><b>${label}</b><em>${sourceShortLabel(item)}</em></div>`;

  return {
    content,
    size: new naver.maps.Size(size, size),
    anchor: new naver.maps.Point(size / 2, size / 2)
  };
}

function markerColor(item, kind, isCluster) {
  if (isCluster && kind === "mixed") return "#111827";
  if (kind === "onbid") return "#ff9500";
  if (kind === "court") return "#007aff";
  if (item.score < 50) return "#b4463e";
  if (item.score < 65) return "#9a6b00";
  return "#11845b";
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

function sourceLabel(item) {
  return sourceKind(item) === "onbid" ? "온비드 공매" : "법원 경매";
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
      <span class="case-no">${item.caseNo}</span>
    </div>
    <section class="detail-header">
      <div class="risk-row">
        <span class="case-no">${sourceBadge(item)}${item.caseNo}</span>
        <span class="risk-badge ${riskClass[item.risk]}">위험 ${item.risk}</span>
      </div>
      <h2>${item.title}</h2>
      <p class="detail-meta">${item.address}<br />입찰일 ${formatDate(item.bidDate)} · ${item.failCount}회 유찰 · ${item.zoning}</p>
    </section>
    <section class="detail-grid" aria-label="상세 수치">
      ${detailStat("추천 점수", `${item.score}점`)}
      ${detailStat("최저입찰가", formatWon(item.minBid))}
      ${detailStat("공시기준가", formatWon(item.officialValue))}
      ${detailStat("공시가 대비", formatSignedPercent(item.officialDiscount), item.officialDiscount >= 0 ? "positive" : "negative")}
      ${detailStat("실거래 추정가", formatWon(item.marketValue))}
      ${detailStat("실거래 대비", formatSignedPercent(item.marketDiscount), item.marketDiscount >= 0 ? "positive" : "negative")}
      ${item.officialLandPriceSource ? detailStat("공시지가 기준", `${item.officialLandPriceYear}년`) : ""}
      ${item.marketDealSource ? detailStat("실거래 출처", item.marketDealScope || "서울시") : ""}
    </section>
    <section class="detail-section">
      <h3>판단 메모</h3>
      <p class="address">${item.memo}</p>
      <div class="tag-row">${item.checks.map(displayCheckLabel).map((check) => `<span class="tag">${check}</span>`).join("")}</div>
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
                <strong>${deal.label}</strong><br />
                <span class="case-no">${deal.date}${formatDealMeta(deal)}</span>
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
      <strong>${item.source}</strong>
    </div>
  `;

  document.querySelector("#backToRecommendations")?.addEventListener("click", showRecommendationList);
}

function formatDealMeta(deal) {
  const parts = [];
  if (deal.distanceLabel) {
    parts.push(deal.distanceLabel);
  } else if (Number(deal.distance) > 0) {
    parts.push(`${deal.distance}m`);
  }
  if (Number(deal.area) > 0) parts.push(`${stripZero(Number(deal.area))}㎡`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function detailStat(label, value, tone = "") {
  return `
    <div class="detail-stat">
      <span>${label}</span>
      <strong class="${tone}">${value}</strong>
    </div>
  `;
}

function displayCheckLabel(value) {
  return String(value || "")
    .replace(/VWorld\s*/gi, "")
    .replace(/주소검색/g, "주소 좌표 확인")
    .replace(/공시지가속성조회/g, "공시지가 확인")
    .trim();
}

function formatWon(value) {
  if (Math.abs(value) >= 100000000) {
    const eok = value / 100000000;
    return `${stripZero(eok)}억`;
  }
  if (Math.abs(value) >= 10000) {
    const man = value / 10000;
    return `${Math.round(man).toLocaleString("ko-KR")}만`;
  }
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
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

function formatDate(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric"
  }).format(new Date(value));
}
