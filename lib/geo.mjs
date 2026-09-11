import { firstValue, numberFrom } from "./util.mjs";

// 좌표 추정 테이블은 이 모듈 한 곳에서만 관리한다.
// 1) PROVINCE_CENTERS: 주소가 시/도명으로 시작할 때 쓰는 1차 패스
// 2) CITY_CENTERS: 시/군/구 행정구역 이름 매칭용 2차 패스
// 3) LOOSE_CENTERS: 주소 형식이 아닌 텍스트(법원명 등)에 대한 느슨한 포함 검색용

const PROVINCE_CENTERS = [
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

const CITY_CENTERS = [
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

const SCOPED_CITY_CENTERS = {
  인천: [
    ["중구", 37.4737, 126.6215],
    ["동구", 37.4739, 126.6432],
    ["미추홀구", 37.4635, 126.6507],
    ["연수구", 37.4100, 126.6783],
    ["남동구", 37.4473, 126.7315],
    ["부평구", 37.5070, 126.7218],
    ["계양구", 37.5374, 126.7377],
    ["서구", 37.5455, 126.6759],
    ["강화군", 37.7465, 126.4877],
    ["옹진군", 37.4466, 126.6369]
  ],
  부산: [
    ["중구", 35.1064, 129.0324],
    ["서구", 35.0979, 129.0244],
    ["동구", 35.1293, 129.0453],
    ["영도구", 35.0912, 129.0679],
    ["부산진구", 35.1629, 129.0532],
    ["동래구", 35.2054, 129.0838],
    ["남구", 35.1366, 129.0842],
    ["북구", 35.1972, 128.9900],
    ["해운대구", 35.1631, 129.1636],
    ["사하구", 35.1045, 128.9748],
    ["금정구", 35.2428, 129.0920],
    ["강서구", 35.2122, 128.9806],
    ["연제구", 35.1762, 129.0797],
    ["수영구", 35.1456, 129.1131],
    ["사상구", 35.1526, 128.9911],
    ["기장군", 35.2446, 129.2220]
  ],
  대구: [
    ["중구", 35.8693, 128.6062],
    ["동구", 35.8869, 128.6356],
    ["서구", 35.8717, 128.5590],
    ["남구", 35.8460, 128.5974],
    ["북구", 35.8856, 128.5829],
    ["수성구", 35.8584, 128.6307],
    ["달서구", 35.8299, 128.5327],
    ["달성군", 35.7747, 128.4313],
    ["군위군", 36.2429, 128.5728]
  ],
  대전: [
    ["동구", 36.3121, 127.4549],
    ["중구", 36.3255, 127.4213],
    ["서구", 36.3553, 127.3836],
    ["유성구", 36.3622, 127.3562],
    ["대덕구", 36.3468, 127.4155]
  ],
  광주: [
    ["동구", 35.1461, 126.9231],
    ["서구", 35.1520, 126.8902],
    ["남구", 35.1329, 126.9025],
    ["북구", 35.1740, 126.9119],
    ["광산구", 35.1395, 126.7937]
  ],
  울산: [
    ["중구", 35.5697, 129.3328],
    ["남구", 35.5438, 129.3301],
    ["동구", 35.5048, 129.4166],
    ["북구", 35.5826, 129.3612],
    ["울주군", 35.5221, 129.2422]
  ]
};

const LOOSE_CENTERS = [
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

// 시·도가 지도 화면에서 얼마나 넓게 퍼져 있는지 판단할 때 쓰는 대략 범위.
// [이름, 남서위도, 남서경도, 북동위도, 북동경도] — 실제 경매 물건 좌표의 가운데 96%로 잡았다.
// 행정 경계가 아니라 "물건이 실제로 있는 범위"다. 화면 대비 폭만 재는 용도라 이게 더 맞다.
const PROVINCE_EXTENTS = [
  ["서울특별시", 37.472, 126.816, 37.657, 127.144],
  ["부산광역시", 35.079, 128.982, 35.321, 129.222],
  ["대구광역시", 35.650, 128.408, 36.097, 128.732],
  ["인천광역시", 37.399, 126.458, 37.635, 126.747],
  ["광주광역시", 35.086, 126.786, 35.221, 126.945],
  ["대전광역시", 36.266, 127.302, 36.444, 127.466],
  ["울산광역시", 35.372, 129.073, 35.684, 129.440],
  ["세종특별자치시", 36.441, 127.180, 36.685, 127.365],
  ["경기도", 36.965, 126.620, 37.890, 127.313],
  ["강원특별자치도", 37.159, 127.236, 38.306, 128.832],
  ["충청북도", 36.177, 127.392, 37.164, 128.307],
  ["충청남도", 36.099, 126.409, 36.940, 127.495],
  ["전북특별자치도", 35.463, 126.477, 35.998, 127.873],
  ["전라남도", 34.457, 126.130, 35.306, 127.740],
  ["경상북도", 35.659, 127.969, 36.925, 129.507],
  ["경상남도", 34.746, 127.786, 35.612, 128.894],
  ["제주특별자치도", 33.228, 126.175, 33.543, 126.913]
];

// 화면에 걸치는 시·도와, 그 시·도가 화면에서 차지하는 폭을 돌려준다.
// share가 크면 그 시·도는 화면에서 넓게 퍼져 있다는 뜻이라 시·군·구로 쪼개야 읽힌다
// (app.js의 ADMIN_SPLIT_SHARE와 같은 판단 기준이다).
export function provincesInBounds(bounds) {
  const viewLat = Math.max(bounds.neLat - bounds.swLat, 1e-6);
  const viewLng = Math.max(bounds.neLng - bounds.swLng, 1e-6);

  return PROVINCE_EXTENTS.map(([name, swLat, swLng, neLat, neLng]) => {
    const overlapLat = Math.min(neLat, bounds.neLat) - Math.max(swLat, bounds.swLat);
    const overlapLng = Math.min(neLng, bounds.neLng) - Math.max(swLng, bounds.swLng);
    if (overlapLat <= 0 || overlapLng <= 0) return null;

    // 물건 분포의 한가운데를 찍으면 경기도 마커가 서울 바로 옆에 붙어 라벨이 겹친다
    // (경기도 물건이 서울 근교에 몰려 있어서다). 사람이 아는 시·도 중심을 쓰고,
    // 화면 밖으로 나가지 않게만 잘라 준다.
    const center = PROVINCE_CENTERS.find((entry) => entry[0] === name);
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const viewSwLat = Math.max(swLat, bounds.swLat);
    const viewNeLat = Math.min(neLat, bounds.neLat);
    const viewSwLng = Math.max(swLng, bounds.swLng);
    const viewNeLng = Math.min(neLng, bounds.neLng);

    return {
      name,
      lat: center ? clamp(center[1], viewSwLat, viewNeLat) : (viewSwLat + viewNeLat) / 2,
      lng: center ? clamp(center[2], viewSwLng, viewNeLng) : (viewSwLng + viewNeLng) / 2,
      // 화면에 걸친 부분이 아니라 시·도 전체 폭으로 잰다. 화면을 살짝 벗어난 시·도가
      // "좁다"고 잘못 판정돼 통으로 묶이는 걸 막는다.
      share: Math.max((neLat - swLat) / viewLat, (neLng - swLng) / viewLng)
    };
  }).filter(Boolean);
}

export function guessRegion(address) {
  return String(address).split(" ").slice(0, 2).join(" ") || "지역 미상";
}

export function cleanAuctionAddress(value) {
  return String(value || "")
    .replace(/^\s*(사용본거지|소재지|물건소재지)\s*:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function roughPointForAddress(value) {
  const text = cleanAuctionAddress(value);
  const startsInMetro = /^(서울|서울특별시|경기|경기도|인천|인천광역시)(\s|$)/.test(text);
  const province = PROVINCE_CENTERS.find(([name]) => text.startsWith(name));
  const scoped = province ? scopedCityCenterForAddress(text, province[0]) : null;
  if (scoped) return scoped;
  if (province && !/^(서울|서울특별시|경기|경기도)(\s|$)/.test(text)) {
    return { lat: province[1], lng: province[2] };
  }
  if (province && !startsInMetro) return { lat: province[1], lng: province[2] };

  const picked = CITY_CENTERS.find(([name]) => matchesAdminName(text, name));
  return picked ? { lat: picked[1], lng: picked[2] } : null;
}

function scopedCityCenterForAddress(text, provinceName) {
  const scopeKey = normalizeScopeKey(provinceName);
  const centers = SCOPED_CITY_CENTERS[scopeKey];
  if (!centers) return null;

  const picked = centers.find(([name]) => matchesAdminName(text, name));
  return picked ? { lat: picked[1], lng: picked[2] } : null;
}

function normalizeScopeKey(value) {
  if (String(value).startsWith("인천")) return "인천";
  if (String(value).startsWith("부산")) return "부산";
  if (String(value).startsWith("대구")) return "대구";
  if (String(value).startsWith("대전")) return "대전";
  if (String(value).startsWith("광주")) return "광주";
  if (String(value).startsWith("울산")) return "울산";
  return "";
}

function matchesAdminName(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/[시군구]$/.test(name)) {
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(text);
  }
  return new RegExp(`(^|\\s)${escaped}(시|군|구|\\s|$)`).test(text);
}

export function fallbackPointForAddress(value) {
  const text = String(value || "");
  const rough = roughPointForAddress(text);
  if (rough) {
    const seed = stableNumber(text);
    return {
      lat: rough.lat + ((seed % 1000) / 1000 - 0.5) * 0.018,
      lng: rough.lng + ((Math.floor(seed / 1000) % 1000) / 1000 - 0.5) * 0.018
    };
  }

  const picked = LOOSE_CENTERS.find(([name]) => text.includes(name)) || ["전국", 36.5, 127.8];
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

export function hasUsableCoordinates(value) {
  return Boolean(
    numberFrom(firstValue(value, ["lat", "latitude", "y"])) &&
    numberFrom(firstValue(value, ["lng", "longitude", "x"]))
  );
}

export function parseViewportBounds(params) {
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

// 좌표가 없는 행의 추정 좌표는 행 객체 기준으로 메모이즈해 반복 스캔 비용을 줄인다.
const roughPointCache = new WeakMap();

export function isRoughlyInsideBounds(row, bounds, roughTextFn) {
  const lat = numberFrom(firstValue(row, ["lat", "latitude", "y"]));
  const lng = numberFrom(firstValue(row, ["lng", "longitude", "x"]));
  let point = lat && lng ? { lat, lng } : null;

  if (!point) {
    if (roughPointCache.has(row)) {
      point = roughPointCache.get(row);
    } else {
      const roughText = roughTextFn
        ? roughTextFn(row)
        : row?.address || row?.addr || row?.court || row?.court_name || "";
      point = fallbackPointForAddress(roughText);
      roughPointCache.set(row, point);
    }
  }
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

export function isPropertyInsideBounds(item, bounds) {
  return item.lat >= bounds.swLat && item.lat <= bounds.neLat && item.lng >= bounds.swLng && item.lng <= bounds.neLng;
}
