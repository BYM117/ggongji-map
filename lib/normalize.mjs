import { firstValue, numberFrom } from "./util.mjs";
import { guessRegion } from "./geo.mjs";

export function normalizeProperty(raw) {
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
    officialPrice: numberFrom(raw.officialPrice) || 0,
    officialPriceType: raw.officialPriceType || "",
    officialPriceYear: raw.officialPriceYear || "",
    officialPriceDetail: raw.officialPriceDetail || null,
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

export function inferPropertyType(value) {
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
