import { firstValue, numberFrom } from "./util.mjs";
import { guessRegion } from "./geo.mjs";
import { classifyProperty, groupIdOf, legacyType, needsStandardPriceLookup, subLabel } from "../categories.js";
import { lookupOfficetelKind } from "./officetel.mjs";
import { mapWithConcurrency } from "./util.mjs";

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

  // 소스 어댑터(court/onbid)가 이미 분류해 두었으면 그걸 그대로 쓴다.
  // 여기서 다시 분류하면 대괄호(목록구분·지목)가 잘려나간 주소로 판정하게 되어
  // 집합건물/토지 구분과 지목이 통째로 사라진다.
  const rawCategory = String(firstValue(raw, ["type", "category", "물건유형", "용도", "CTGR_FULL_NM", "goodsKndNm", "usage"]) || "");
  const rawTitle = String(firstValue(raw, ["title", "name", "물건명", "물건이름", "GOODS_NM", "goodsNm"]) || "");
  const classified = raw.categorySub
    ? { sub: raw.categorySub, group: raw.categoryGroup, saleForm: raw.saleForm, confident: raw.categoryConfident !== false, type: raw.type }
    : classifyItem({ category: rawCategory, address: String(raw.rawAddress || address), title: rawTitle });

  return {
    id: String(firstValue(raw, ["id", "caseNo", "case_no", "itemNo", "물건번호", "PLNM_NO", "pbctNo"]) || `property-${lat}-${lng}-${minBid}`),
    caseNo: String(firstValue(raw, ["caseNo", "case_no", "itemNo", "사건번호", "물건번호", "PLNM_NO", "pbctNo"]) || "실데이터"),
    title: String(firstValue(raw, ["title", "name", "물건명", "물건이름", "GOODS_NM", "goodsNm"]) || address || "경공매 물건"),
    type: classified.type,
    categoryGroup: classified.group,
    categorySub: classified.sub,
    categoryConfident: classified.confident,
    saleForm: classified.saleForm,
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

// 법원이 "상가,오피스텔,근린시설"처럼 묶어서만 공개한 물건의 용도를 서버에서 확정한다.
//
// 화면에서 기준시가를 조회할 때도 같은 확정이 일어나지만(app.js refinedCategory),
// 그건 지도에 뜬 물건이 조회를 끝낸 뒤라야 반영된다. 그러면 칩에 붙는 건수가
// 처음에는 틀린 값으로 보였다가 나중에 움직인다. 여기서 미리 확정해 두면
// 화면 밖 물건까지 검색·필터가 처음부터 맞는다.
export async function resolveAmbiguousCategories(properties) {
  const targets = properties.filter(
    (item) => item?.pnu && item.categoryConfident === false && needsStandardPriceLookup(item.categorySub, item.saleForm)
  );
  if (!targets.length) return properties;

  const resolved = new Map();
  await mapWithConcurrency(targets, 8, async (item) => {
    try {
      const kind = await lookupOfficetelKind({ pnu: item.pnu, address: item.rawAddress || item.address });
      if (kind) resolved.set(item.id, kind);
    } catch {
      // 인덱스를 못 읽어도 분류는 추정인 채로 두면 된다. 물건을 잃지 않는 게 우선이다.
    }
    return null;
  });
  if (!resolved.size) return properties;

  return properties.map((item) => {
    const sub = resolved.get(item?.id);
    if (!sub) return item;
    return { ...item, categorySub: sub, categoryGroup: groupIdOf(sub), categoryConfident: true, type: legacyType(sub) };
  });
}

// 종별 분류의 단일 진입점. 서버가 물건에 실어 보내는 필드를 여기서만 만든다.
export function classifyItem({ category = "", address = "", title = "" } = {}) {
  const result = classifyProperty({ category, address, title });
  return { ...result, type: legacyType(result.sub), label: subLabel(result.sub) };
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
