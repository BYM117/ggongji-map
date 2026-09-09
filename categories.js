// 물건 종별 분류. 서버(lib/*.mjs)와 브라우저(app.js)가 같은 파일을 읽어서
// "서버는 이렇게 나누는데 화면은 저렇게 나눈다"가 생기지 않게 한다.
//
// 분류 근거의 우선순위는 데이터를 재보고 정한 것이다.
//  1) 주소 대괄호의 목록구분([집합건물 ...] / [토지 ...] / [건물 ...]) — 무엇을 파는지는 여기가 확실하다
//  2) 토지면 대괄호 안 지목이 그대로 세분류가 된다 (전답 99% / 임야 97% / 대지 91% 일치)
//  3) 건물이면 법원 category leaf가 1순위. 집합건물 용도는 주소 문자열로는 못 맞힌다
//     (건물명만으로 판정하면 아파트 44%, 다세대 9%까지 떨어진다)
//  4) 그 다음이 대괄호 안 용도 토큰 → 건물명 키워드
//
// category에는 개별 용도("아파트")와 법원 검색 그룹 라벨("상가,오피스텔,근린시설")이 섞여 온다.
// 그룹 라벨을 부분 문자열로 훑으면 4천 건이 통째로 오피스텔이 되므로, 정확히 일치할 때만 해석한다.

export const CATEGORY_GROUPS = [
  {
    id: "residential",
    label: "주거",
    subs: [
      { id: "apartment", label: "아파트" },
      { id: "officetel", label: "오피스텔" },
      { id: "villa", label: "빌라·다세대" },
      { id: "house", label: "단독·다가구" },
      { id: "seniorHousing", label: "노인복지주택", hint: "실버타운. 만 60세 이상 입주 자격 등 제한이 붙습니다." }
    ]
  },
  {
    id: "commercial",
    label: "상가·업무",
    subs: [
      { id: "retail", label: "근린상가" },
      { id: "office", label: "사무실·업무" },
      { id: "lodging", label: "숙박시설" },
      { id: "commercialEtc", label: "기타 상업시설" },
      { id: "retailOrOfficetel", label: "상가·오피스텔 미확정", hint: "법원이 상가·오피스텔·근린시설을 한 묶음으로만 공개한 물건. 기준시가 조회가 끝나면 자동으로 갈립니다." }
    ]
  },
  {
    id: "industrial",
    label: "산업",
    subs: [
      { id: "knowledgeCenter", label: "지식산업센터" },
      { id: "factory", label: "공장" },
      { id: "warehouse", label: "창고·물류" }
    ]
  },
  {
    id: "land",
    label: "토지",
    subs: [
      { id: "siteLand", label: "대지" },
      { id: "farmland", label: "농지(전·답·과수원)", hint: "농지취득자격증명이 필요합니다." },
      { id: "forest", label: "임야" },
      { id: "industrialLand", label: "공장·창고용지" },
      { id: "miscLand", label: "잡종지" },
      { id: "roadRiver", label: "도로·하천", hint: "단독으로는 활용이 어렵습니다." },
      { id: "etcLand", label: "기타 지목" }
    ]
  },
  {
    id: "etc",
    label: "기타",
    subs: [
      { id: "unknown", label: "용도 확인필요" },
      { id: "vessel", label: "선박·어업권" },
      { id: "vehicle", label: "차량·중기" }
    ]
  }
];

export const SALE_FORMS = [
  { id: "unit", label: "집합건물", hint: "구분소유 한 호실" },
  { id: "landOnly", label: "토지" },
  { id: "buildingOnly", label: "건물만", hint: "토지 미포함. 법정지상권을 확인하세요." },
  { id: "other", label: "기타" }
];

export const SUB_INDEX = new Map();
for (const group of CATEGORY_GROUPS) {
  for (const sub of group.subs) {
    SUB_INDEX.set(sub.id, { ...sub, groupId: group.id, groupLabel: group.label });
  }
}

export function subLabel(id) {
  return SUB_INDEX.get(id)?.label || "용도 확인필요";
}

export function groupIdOf(subId) {
  return SUB_INDEX.get(subId)?.groupId || "etc";
}

export function saleFormLabel(id) {
  return SALE_FORMS.find((form) => form.id === id)?.label || "";
}

// 법원 검색 그룹 라벨. 정확히 일치할 때만 해석한다.
const GROUP_LABEL_SUBS = {
  "연립주택,다세대,빌라": "villa",
  "단독주택다가구": "house",
  "상가,오피스텔,근린시설": "retailOrOfficetel"
};

const LEAF_SUBS = {
  "아파트": "apartment",
  "오피스텔": "officetel",
  "다세대": "villa",
  "연립주택": "villa",
  "빌라": "villa",
  "단독주택": "house",
  "다가구주택": "house",
  "상가": "retail",
  "근린시설": "retail"
};

// 주소에서 지목을 못 읽었을 때만 쓰는 카테고리 폴백.
const LAND_CATEGORY_SUBS = {
  "전답": "farmland",
  "임야": "forest",
  "대지": "siteLand",
  "대지,임야,전답": "etcLand"
};

const JIMOK_SUBS = {
  "대": "siteLand",
  "대지": "siteLand",
  "전": "farmland",
  "답": "farmland",
  "과수원": "farmland",
  "임야": "forest",
  "공장용지": "industrialLand",
  "창고용지": "industrialLand",
  "잡종지": "miscLand",
  "도로": "roadRiver",
  "구거": "roadRiver",
  "하천": "roadRiver",
  "유지": "roadRiver",
  "제방": "roadRiver"
};

const VEHICLE_RE = /승용차|화물차|승합차|덤프트럭|굴착기|지게차|로더|크레인|\d{4}\s*년식/;

// 지식산업센터는 법원이 "기타" 또는 "상가,오피스텔,근린시설"로만 보내서 이름으로 알아봐야 한다.
// 브랜드명을 넣은 건 이름에 "지식산업센터"가 그대로 박힌 물건이 소수라서다.
// 후보는 실제 데이터로 걸렀다 — 분류가 여기까지 내려오는 물건 중 주거 카테고리가 하나도 없고,
// 국세청 인덱스 교차검증에서도 상업용으로 나오는 이름만 남겼다.
// "비즈니스센터"는 11건 중 7건이 오피스텔이라 뺐다.
const KNOWLEDGE_CENTER_RE = /지식산업센터|지식산업|아파트형공장|테크노|아이티타워|테라타워|하이테크|브이원|라이온스밸리|클러스터|벤처타워/;

// 노인복지주택(실버타운). 주거지만 입주 자격·전매 제한이 붙어서 일반 주거와 섞으면 안 된다.
// 국세청 상업용건물 인덱스에 56건 중 54건이 없다 = 상업시설이 아니라 주거시설이다.
const SENIOR_HOUSING_RE = /시니어스|시니어캐슬|실버타운|노인복지/;

// 주소 끝 대괄호가 목록구분("집합건물 철근콘크리트구조 59.94㎡" 같은 것)을 담고 있다.
// 대괄호가 통째로 없으면 목록구분과 지목이 사라져 토지 세분화가 무너지므로,
// 공급자가 대괄호를 어느 필드에 담아 보내든 찾아 쓸 수 있게 후보를 순서대로 본다.
export function pickClassifyAddress(...candidates) {
  const values = candidates.map((value) => String(value || "")).filter(Boolean);
  return values.find((value) => value.includes("[")) || values[0] || "";
}

// 목록구분은 대괄호 안 첫 단어인 게 보통이지만 항상 그렇지는 않다.
//  - 주소 중간에 "[현황:성산마리나호텔]" 같은 괄호가 먼저 붙는 물건이 있고
//  - "[집합건물 [집합건물] 1동의 건물의 표시 …]"처럼 대괄호가 중첩된 물건도 있다
// 그래서 첫 단어만 보면 목록구분을 놓친다. 위치와 무관하게 찾는다.
// 순서가 중요하다 — "집합건물"이 "건물"보다 앞에 와야 한다.
const LISTING_KIND_RE = /(집합건물|토지|건물|선박|어업권)/;

function readBracket(address) {
  const text = String(address || "");
  const matches = text.match(/\[[^\]]*\]/g);
  // 대괄호 없이 목록구분만 따로 오는 필드(address.detail)도 그대로 읽을 수 있게 한다.
  const body = matches ? matches[matches.length - 1].slice(1, -1).trim() : text.trim();
  const found = LISTING_KIND_RE.exec(body);
  if (!found) return { head: "", body };
  return { head: found[1], body, headIndex: found.index + found[1].length };
}

// 지목은 "토지" 바로 뒤 토큰이다. "토지"가 문자열 중간에 있을 수 있으므로
// 첫 단어를 세지 않고 목록구분이 끝난 지점부터 읽는다.
function readJimok(body, headIndex = 0) {
  const rest = String(body || "").slice(headIndex).trim();
  const token = rest.split(/\s+/)[0] || "";
  return token.split(/[[(\d]/)[0];
}

// 지하/1층은 상가가 거의 확실하다(국세청 기준시가 대조: 1층 상가 99%, 지하 77%).
// 위층은 오피스텔 쪽이 우세하지만 단정할 만큼은 아니라서 미확정으로 남긴다.
function readFloor(address) {
  const text = String(address || "").replace(/\[[^\]]*\]/g, " ");
  const matches = [...text.matchAll(/(지하|지)?\s*(\d+)\s*층/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return last[1] ? -Number(last[2]) : Number(last[2]);
}

function saleFormOf(head) {
  if (head === "집합건물") return "unit";
  if (head === "토지") return "landOnly";
  if (head === "건물") return "buildingOnly";
  return "other";
}

/**
 * @param {{category?: string, address?: string, title?: string}} input
 * @returns {{sub: string, group: string, saleForm: string, confident: boolean}}
 */
export function classifyProperty({ category = "", address = "", title = "" } = {}) {
  const cat = String(category || "").trim();
  const addr = String(address || "");
  const { head, body, headIndex } = readBracket(addr);
  const saleForm = saleFormOf(head);
  const done = (sub, confident = true) => ({ sub, group: groupIdOf(sub), saleForm, confident });

  // 부동산이 아닌 것부터 걷어낸다.
  if (head === "선박" || addr.includes("선적항")) return done("vessel");
  if (head === "어업권" || addr.includes("어장의위치")) return done("vessel");
  if (addr.includes("사용본거지") || head.startsWith("건설기계") || VEHICLE_RE.test(body)) return done("vehicle");
  if (cat === "자동차" || cat === "중기" || cat === "자동차,중기") return done("vehicle");

  // 토지는 지목이 곧 세분류다.
  if (head === "토지") return done(JIMOK_SUBS[readJimok(body, headIndex)] || "etcLand");

  // 키워드 매칭 텍스트에 cat을 넣으면 안 된다.
  // 그룹 라벨("상가,오피스텔,근린시설")이 부분 문자열로 걸려서 전부 오피스텔이 되는 게 원래 버그였다.
  const text = `${addr} ${title}`;

  // 건물은 법원 leaf가 가장 믿을 만하다.
  if (LEAF_SUBS[cat]) {
    // 단, 지식산업센터는 법원이 상가/근린으로 묶어버려서 이름으로 되살린다.
    if (LEAF_SUBS[cat] === "retail" && KNOWLEDGE_CENTER_RE.test(text)) return done("knowledgeCenter");
    return done(LEAF_SUBS[cat]);
  }

  // 대괄호 안에 건축물 용도가 적힌 경우(전체의 9% 정도지만 적혀 있으면 정확하다).
  if (/오피스텔/.test(body)) return done("officetel");
  if (/아파트(?!형)/.test(body)) return done("apartment");
  if (/도시형생활주택|다세대주택|연립주택|공동주택/.test(body)) return done("villa");
  if (/단독주택|다가구주택|농가주택/.test(body)) return done("house");
  if (/숙박시설/.test(body)) return done("lodging");
  if (/공장|제조업소/.test(body)) return done("factory");
  if (/창고/.test(body)) return done("warehouse");
  if (/업무시설|사무실/.test(body)) return done("office");
  if (/근린생활시설|상점|소매점|음식점|판매시설/.test(body)) return done("retail");

  // 건물명·주소 키워드.
  if (SENIOR_HOUSING_RE.test(text)) return done("seniorHousing");
  if (KNOWLEDGE_CENTER_RE.test(text)) return done("knowledgeCenter");
  if (/생활숙박|레지던스|호텔|모텔|여관|펜션|콘도|리조트|관광숙박/.test(text)) return done("lodging");
  if (/오피스텔/.test(text)) return done("officetel");
  if (/아파트(?!형)/.test(text)) return done("apartment");
  if (/주유소|충전소|장례식장|예식장|병원|의원|목욕탕|골프연습장/.test(text)) return done("commercialEtc");
  if (/물류센터|창고/.test(text)) return done("warehouse");
  if (/공장/.test(text)) return done("factory");

  // 그룹 라벨은 여기서만, 정확히 일치할 때만 해석한다.
  const grouped = GROUP_LABEL_SUBS[cat];
  if (grouped === "retailOrOfficetel") {
    const floor = readFloor(addr);
    if (floor !== null && floor <= 1) return done("retail", floor === 1);
    return done("retailOrOfficetel", false);
  }
  if (grouped) return done(grouped);

  if (/다세대|연립|빌라/.test(text)) return done("villa");
  if (/단독주택|다가구|주택/.test(text)) return done("house");
  if (/상가|근린|점포/.test(text)) return done("retail");

  // 마지막 방어선. 목록구분·지목이 통째로 없는 주소가 들어와도 카테고리만으로 토지를 살린다.
  // 단 목록구분이 건물이라고 말하고 있으면 쓰지 않는다. 사건 카테고리는 "임야"인데
  // 정작 나온 물건은 집합건물인 경우가 실제로 있고, 그건 토지가 아니다.
  if (LAND_CATEGORY_SUBS[cat] && !head) return done(LAND_CATEGORY_SUBS[cat], false);

  return done("unknown", false);
}

// 국세청 상업용건물·오피스텔 기준시가는 호실 단위로 용도를 들고 있다.
// 조회가 성공하면 미확정 물건의 용도가 확정된다.
export function refineSubWithStandardPrice(sub, source) {
  if (!needsStandardPriceLookup(sub)) return sub;
  const text = String(source || "");
  if (text.startsWith("오피스텔")) return "officetel";
  if (text.startsWith("상업용건물")) return "retail";
  return sub;
}

// 건축물대장 주용도 → 세분류.
// 이건 국세청 호실 조회가 답을 못 냈을 때만 쓰는 폴백이다. 순서를 지켜야 하는 이유는,
// 주용도가 "이 물건의 용도"가 아니라 "이 필지 대표 건물의 용도"이기 때문이다.
// 수집기는 한 필지에 여러 동이 있으면 연면적이 가장 큰 동을 고른다. 그래서 주상복합에서
// 아파트 동이 오피스텔 동보다 크면 오피스텔 물건에도 "공동주택"이 붙는다.
// 국세청 인덱스는 호실 단위라 그런 문제가 없다 — 그쪽이 항상 우선이다.
const BUILDING_PURPOSE_SUBS = {
  "제1종근린생활시설": "retail",
  "제2종근린생활시설": "retail",
  "근린생활시설": "retail",
  "판매시설": "retail",
  "판매및영업시설": "retail",
  // 오피스텔은 국세청 기준시가 대상이라 앞 단계에서 대부분 걸러진다.
  // 여기까지 내려온 업무시설은 사무실 쪽으로 보는 게 실제에 가깝다.
  "업무시설": "office",
  "숙박시설": "lodging",
  "공장": "factory",
  "창고시설": "warehouse",
  "단독주택": "house",
  "공동주택": "villa",
  "의료시설": "commercialEtc",
  "교육연구시설": "commercialEtc",
  "운동시설": "commercialEtc",
  "노유자시설": "commercialEtc",
  "문화및집회시설": "commercialEtc",
  "위락시설": "commercialEtc",
  "자동차관련시설": "commercialEtc",
  "종교시설": "commercialEtc",
  "운수시설": "commercialEtc",
  "동물및식물관련시설": "commercialEtc",
  "위험물저장및처리시설": "commercialEtc",
  "자원순환관련시설": "commercialEtc",
  "야영장시설": "commercialEtc",
  "관광휴게시설": "commercialEtc",
  "수련시설": "commercialEtc"
};

/**
 * 건축물대장 주용도로 미확정 물건의 용도를 좁힌다.
 * 확정할 수 없으면 원래 값을 그대로 돌려준다.
 */
export function refineSubWithBuildingPurpose(sub, purpose) {
  if (!needsStandardPriceLookup(sub)) return sub;
  const mapped = BUILDING_PURPOSE_SUBS[String(purpose || "").trim()];
  if (!mapped) return sub;

  // 법원은 상가·오피스텔·근린시설이라 했는데 대장은 공동주택이라고 하는 경우가 있다.
  // 둘이 정면으로 어긋나면 대장의 "필지 대표 건물" 한계일 가능성이 높으므로 단정하지 않는다.
  // (수집기 쪽 실측으로 이 조합이 634건 있고, 주상복합 주거부분일 수도 있어 판단이 갈린다)
  if (sub === "retailOrOfficetel" && mapped === "villa") return sub;

  return mapped;
}

// 국세청 인덱스를 뒤져볼 가치가 있는 미확정 물건인지 판단한다.
// 인덱스는 상업용건물·오피스텔만 담고 있어서, 구분소유 건물이 아니면 뒤져도 안 나온다.
// (실측: 상가·오피스텔 미확정 54% 확정, 집합건물 중 용도 확인필요 40% 확정,
//  집합건물이 아닌 용도 확인필요는 0%. 그래서 마지막은 아예 조회하지 않는다.)
export function needsStandardPriceLookup(sub, saleForm) {
  if (sub === "retailOrOfficetel") return true;
  if (sub === "unknown") return saleForm === undefined || saleForm === "unit";
  return false;
}

// 실거래가 조회와 면적 추정이 쓰는 기존 유형 값. 새 세분류에서 파생시켜 한 곳에서만 정한다.
const LEGACY_TYPES = {
  apartment: "아파트",
  officetel: "오피스텔",
  villa: "빌라",
  house: "단독주택",
  retail: "상가",
  office: "상가",
  lodging: "상가",
  commercialEtc: "상가",
  retailOrOfficetel: "오피스텔",
  seniorHousing: "기타",
  knowledgeCenter: "상가",
  factory: "상가",
  warehouse: "상가",
  siteLand: "토지",
  farmland: "토지",
  forest: "토지",
  industrialLand: "토지",
  miscLand: "토지",
  roadRiver: "토지",
  etcLand: "토지",
  unknown: "기타",
  vessel: "기타",
  vehicle: "기타"
};

export function legacyType(sub) {
  return LEGACY_TYPES[sub] || "기타";
}
