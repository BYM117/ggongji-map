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
