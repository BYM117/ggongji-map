import { numberFrom } from "./util.mjs";
import { fetchHousingPrice, fetchLandPrice, fetchVworldPoint, cleanGeocodeAddress } from "./vworld.mjs";
import { fetchOfficetelPrice } from "./officetel.mjs";

// 공시가격 기준 물건 유형 분류. 클라이언트 officialPropertyKind와 규칙을 맞춘다.
export function classifyOfficialKind({ category = "", typeGuess = "", title = "", address = "" } = {}) {
  const text = `${category} ${typeGuess} ${title} ${address}`;
  if (/(아파트|다세대|연립|공동주택|빌라)/.test(text)) return "commonHousing";
  if (/오피스텔/.test(text)) return "officetel";
  if (/(단독|다가구|주택)/.test(text)) return "detachedHousing";
  if (typeGuess === "토지" || /(임야|대지|잡종지|과수원|목장용지|공장용지|도로|하천|구거|체육용지)/.test(text) || /\b[전답]\b/.test(text)) {
    if (!/(건물|아파트|다세대|연립|빌라|주택|오피스텔|상가|공장|창고|근린)/.test(text)) return "land";
    if (typeGuess === "토지") return "land";
  }
  return "mixed";
}

// 한 물건에 대한 공시가격 사이드카 패치를 계산한다.
// 필요하면 지오코딩으로 PNU를 확보하고, 유형에 맞는 공시가격/기준시가를 조회한다.
export async function computeOfficialFields({ id, kind, pnu, address, cleanAddress, landArea, year }) {
  const patch = {};
  let resolvedPnu = pnu || "";

  if (!["land", "commonHousing", "detachedHousing", "officetel"].includes(kind)) {
    return { patch, resolvedPnu, status: "skip_kind" };
  }

  if (!resolvedPnu) {
    const point = await fetchVworldPoint(cleanGeocodeAddress(cleanAddress || address));
    if (point?.pnu) {
      resolvedPnu = point.pnu;
      patch.pnu = point.pnu;
      if (point.lat && point.lng) {
        patch.lat = point.lat;
        patch.lng = point.lng;
        patch.geocodeSource = "주소 좌표 확인";
      }
    } else {
      return { patch, resolvedPnu, status: "geocode_miss" };
    }
  }

  if (kind === "officetel") {
    const payload = await fetchOfficetelPrice(toParams({ pnu: resolvedPnu, address }));
    if (payload.ok && payload.price > 0) {
      patch.publicStandardPrice = payload.price;
      patch.publicStandardPriceSource = payload.source;
      patch.publicStandardPriceUnit = payload.matched || null;
      return { patch, resolvedPnu, status: "priced" };
    }
    return { patch, resolvedPnu, status: "price_miss" };
  }

  if (kind === "land") {
    const payload = await fetchLandPrice(toParams({ pnu: resolvedPnu, year }));
    if (payload.ok && payload.pricePerSqm > 0) {
      patch.publicLandPricePerSqm = payload.pricePerSqm;
      patch.officialLandPriceSource = payload.source;
      patch.officialLandPriceYear = payload.year;
      patch.officialLandPricePublishedAt = payload.publishedAt || null;
      patch.officialLandPriceLocation = payload.landCodeName || null;
      return { patch, resolvedPnu, status: "priced" };
    }
    return { patch, resolvedPnu, status: "price_miss" };
  }

  // commonHousing / detachedHousing
  const payload = await fetchHousingPrice(
    toParams({ pnu: resolvedPnu, year, kind: kind === "commonHousing" ? "apart" : "indvd", address })
  );
  if (payload.ok && payload.price > 0) {
    patch.publicHousingPrice = payload.price;
    patch.publicHousingPriceSource = payload.source;
    patch.publicHousingPriceYear = payload.year;
    patch.publicHousingPriceUnit = payload.matched || null;
    return { patch, resolvedPnu, status: "priced" };
  }
  return { patch, resolvedPnu, status: "price_miss" };
}

function toParams(object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params;
}
