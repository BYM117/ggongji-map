// 법원경매 물건 상세(사진·문서·사건 원문)를 크롤러 API에서 가져온다.
//
// 목록(court.mjs)과 달리 상세는 물건을 클릭했을 때만 필요하므로 별도 모듈로 둔다.
// 응답이 크고(사건 원문 테이블 포함) 사진은 바이너리라, 캐시 정책도 목록과 다르다.

import { putBoundedMap } from "./util.mjs";

// 같은 물건을 반복해서 열 때 왕복을 없앤다. 상세는 자주 바뀌지 않는다.
const detailCache = new Map();

export async function fetchCourtAuctionDetail(params) {
  const id = String(params.get("id") || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const baseUrl = courtDetailBaseUrl();
  if (!baseUrl) {
    return { ok: false, error: "court_api_not_configured", message: "COURT_AUCTION_API_URL이 설정되지 않았습니다." };
  }

  if (detailCache.has(id)) return detailCache.get(id);

  const url = `${baseUrl}/api/v1/auctions/${encodeURIComponent(id)}`;
  let payload = null;
  try {
    const response = await fetch(url, courtDetailRequestInit());
    if (!response.ok) {
      return { ok: false, error: "court_api_error", status: response.status };
    }
    payload = await response.json();
  } catch (error) {
    console.error("court detail fetch failed", id, error.message);
    return { ok: false, error: "court_api_unreachable" };
  }

  const result = { ok: true, detail: normalizeDetail(payload) };
  putBoundedMap(detailCache, id, result, 500);
  return result;
}

// 크롤러 응답에서 화면이 쓰는 것만 추린다. 원문 전체를 그대로 내려보내면
// 사건 테이블만 수십 KB라 상세 열 때마다 낭비다.
function normalizeDetail(raw) {
  if (!raw || typeof raw !== "object") return null;

  const property = raw.property || {};
  const address = property.address || {};
  const share = property.share || {};
  const area = property.area || {};
  const price = raw.price || {};
  const auction = raw.auction || {};
  const screening = raw.screening || {};
  const documents = normalizeDocuments(raw.documents);

  return {
    id: raw.id || "",
    caseNo: (raw.case || {}).display_case_no || raw.case_no || "",
    // 경매지 딥링크에 쓸 "2024타경109389". 표시용 caseNo는 법원명과 중복·병합 사건이
    // 줄줄이 붙어 있어 그대로는 검색이 안 된다(실측: 앞의 사건번호로 넣으면 1건으로 잡힌다).
    caseKey: caseSearchKey(raw),
    court: (raw.case || {}).court || raw.court || "",
    itemNo: (raw.case || {}).item_no || raw.item_no || "",
    category: property.category || raw.category || "",
    address: {
      raw: address.raw || raw.address || "",
      clean: address.clean || "",
      detail: address.detail || "",
      buildingName: address.building_name || "",
      dong: address.dong || "",
      ho: address.ho || ""
    },
    area: {
      totalSqm: area.total_sqm || null,
      landSqm: area.land_sqm || null,
      buildingSqm: area.building_sqm || null,
      // 평 환산을 크롤러가 해서 보낸다. 화면이 3.305785로 또 나누면 같은 규칙이 두 곳이 된다.
      totalPyeong: area.total_pyeong || null
    },
    share: {
      isShareSale: Boolean(share.is_share_sale),
      fraction: share.fraction || ""
    },
    price: {
      appraisal: price.appraisal || null,
      minimumBid: price.minimum_bid || null,
      minimumBidPercent: price.minimum_bid_percent ?? null,
      official: price.official || null
    },
    auction: {
      saleDate: auction.sale_date || "",
      saleDateRaw: auction.sale_date_raw || "",
      status: auction.status || raw.status || "",
      failCount: auction.fail_count ?? null,
      isActive: auction.is_active !== false,
      // 이것도 빈 "경매사건검색" 양식으로 간다(실측 30/30). 사건이 안 실려 있으면 버린다.
      detailUrl: caseAwareUrl(auction.detail_url || raw.detail_url),
      // 입찰하려면 반드시 들고 가야 하는 돈인데 화면에 한 번도 없었다.
      deposit: auction.deposit && auction.deposit.amount
        ? { amount: auction.deposit.amount, rate: auction.deposit.rate ?? null }
        : null,
      // 음수면 기일이 지났다는 뜻. 경매지에는 그런 물건이 없어서 퍼널 링크를 숨기는 근거로 쓴다.
      daysUntilSale: auction.days_until_sale ?? null,
      specialRights: Array.isArray(auction.special_rights) ? auction.special_rights : []
    },
    // 권리분석. 예전에는 매각물건명세서 본문을 정규식으로 긁어 "인수되는 권리"를 짐작했는데,
    // 이제 크롤러가 구조화해서 보낸다. 화면은 "있다/없다"까지만 쓰고 내용은 경매지로 보낸다.
    rights: normalizeRights(raw.rights),
    // 유찰이 몇 번이었는지가 아니라 "얼마에서 얼마까지 내려왔는지"를 보여주려고 쓴다.
    saleResults: normalizeSaleResults(raw.sale_results),
    // 제시외물건·공부 불일치는 건물 자체의 위험이라 임차인 위험과 따로 센다.
    appraisalFacts: isEmptyObject(property.appraisal_facts) ? null : property.appraisal_facts,
    landUse: raw.land_use && raw.land_use.zone ? { zone: raw.land_use.zone } : null,
    screening: {
      score: screening.score ?? null,
      riskLevel: screening.risk_level || "",
      flags: Array.isArray(screening.flags) ? screening.flags : []
    },
    building: isEmptyObject(raw.building) ? null : raw.building,
    transactions: isEmptyObject(raw.transactions) ? null : raw.transactions,
    photos: normalizePhotos(raw.assets),
    documents,
    caseTables: normalizeCaseTables(raw.detail),
    detailStatus: raw.detail_status || "",
    detailCollectedAt: raw.detail_collected_at || ""
  };
}

function normalizePhotos(assets) {
  if (!Array.isArray(assets)) return [];
  return assets
    .filter((asset) => asset && asset.kind === "photo" && (asset.id || asset.object_key))
    .map((asset) => {
      // 숫자 id는 크롤러 DB에서만 통한다. 객체 스토리지로 서비스되는 배포 환경에는
      // DB가 없어 object_key(내용 해시 기반 파일명)로 찾아야 한다. 둘 다 실어 보내고
      // 프록시가 가능한 쪽을 고른다.
      const params = new URLSearchParams();
      if (asset.id) params.set("id", String(asset.id));
      if (asset.object_key) params.set("key", String(asset.object_key));
      return {
        id: asset.id || null,
        objectKey: asset.object_key || "",
        label: asset.label || "",
        // 크롤러 API를 직접 노출하지 않고 꽁지맵 프록시를 거친다.
        url: `/api/court-auction-asset?${params.toString()}`
      };
    });
}

// 문서는 "무엇이 있는지"와 법원 원문 링크만 내보낸다.
//
// 2026-09-19에는 매각물건명세서·현황조사서 본문을 통째로 실어 보내 앱 안에서 읽게 했다.
// 그런데 그 본문이 곧 권리분석 원재료다 — 꽁지맵은 "넘길까 말까"까지만 답하고 "왜
// 그런지"는 경매지(법원경매 리포트)로 보내기로 정했으므로(2026-10-10), 본문은 빼고
// 공개 문서는 법원경매정보 링크로 넘긴다. 응답 크기도 문서당 2KB 남짓 줄어든다.
function normalizeDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter((doc) => doc && doc.document_type)
    .map((doc) => ({
      type: doc.document_type,
      status: doc.status || "",
      sourceUrl: caseAwareUrl(doc.source_url)
    }));
}

// 사건을 가리키는 링크만 통과시킨다.
//
// 법원경매정보(courtauction.go.kr)는 POST·세션으로 움직이는 사이트라 URL에 사건이 안 실린다.
// 크롤러가 주는 source_url 중 감정평가서·현황조사서는 `index.on?w2xPath=…PGJ159M00.xml`
// 꼴인데, 이건 그냥 "경매사건검색" 화면 주소다 — 눌러 보면 법원부터 다시 고르는 빈 양식이
// 뜬다. 실측 30건에서 감정평가서 30/30, 현황조사서 30/30, auction.detail_url 30/30이 전부
// 그랬다. 검색을 해 봐도 URL이 바뀌지 않는다.
//
// 반대로 매각물건명세서는 전자문서뷰어(ecfs.scourt.go.kr)로 가고 paramData에 사건이
// 들어 있어서 30/30이 바로 그 문서로 열린다.
//
// "원문 보기"라고 써 놓고 빈 화면을 주는 것이 링크가 없는 것보다 나쁘다.
function caseAwareUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  return /[?&](paramData|encParam)=/.test(value) ? value : "";
}

// 경매지 검색에 넣을 사건번호. 표시용 문자열은 "서울북부지방법원 2025타경5636
// 2025타경13121 (병합) · 물건 1"처럼 와서 그대로는 검색이 안 된다.
// 실측(2026-10-10): 앞의 사건번호 하나만 넣으면 중복·병합 사건도 1건으로 잡힌다.
function caseSearchKey(raw) {
  const source = ((raw.case || {}).case_no) || raw.case_no || "";
  return (String(source).match(/\d{4}타경\d+/) || [])[0] || "";
}

// 권리분석. 화면은 여기서 "있다/없다/모른다"만 읽고, 무엇인지는 경매지로 보낸다.
//
// opposable은 일부러 내보내지 않는다. 실측 25건이 전부 "있음"이라 그대로 쓰면
// 모든 물건에 경고가 붙는다 — 공매 지분 매각을 93% 오탐으로 띄웠던 것과 같은 모양이다.
// 진짜 신호는 inherited(실측 36%)와 임차인별 opposable이다.
function normalizeRights(rights) {
  if (!rights || typeof rights !== "object") return null;

  const tenants = Array.isArray(rights.tenants) ? rights.tenants : [];
  const inherited = rights.inherited && typeof rights.inherited === "object" ? rights.inherited : {};

  return {
    // { 임차권: "떠안음" } 형태. 종류만 쓰고 금액·날짜는 쓰지 않는다.
    inheritedKinds: Object.keys(inherited),
    // 이름·전입일은 내보내지 않는다. 개인정보이기도 하고, 그게 경매지가 파는 것이다.
    tenantCount: tenants.length,
    opposableTenantCount: tenants.filter((tenant) => tenant && tenant.opposable === "있음").length,
    // "미상"이면 현장 확인이 필요하다는 뜻이라 따로 구분한다.
    occupancy: (rights.survey && rights.survey.label) || "",
    hasLien: Boolean(rights.lien)
  };
}

// 회차별 결과. "유찰 9회"라는 숫자 하나로는 얼마에서 얼마까지 내려왔는지를 못 보여준다.
// 화면은 이걸로 한 줄 요약과 작은 꺾은선을 그린다.
function normalizeSaleResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .filter((row) => row && row.minimum_bid)
    .map((row) => ({
      saleDate: row.sale_date || "",
      result: row.result || "",
      minimumBid: row.minimum_bid,
      appraisal: row.appraisal || null
    }))
    // 크롤러는 최신순으로 준다. 화면은 왼쪽이 과거인 그래프를 그리므로 뒤집어 둔다.
    .reverse();
}

// 법원 사건 원문 테이블 중 사람이 볼 값만 남긴다.
function normalizeCaseTables(detail) {
  const tables = ((detail || {}).case || {}).case_tables;
  if (!Array.isArray(tables)) return [];

  return tables
    .filter((table) => Array.isArray(table.rows) && table.rows.length)
    .map((table) => ({
      caption: String(table.caption || "").replace(/displayed in the table/gi, "").trim(),
      rows: table.rows.filter((row) => Array.isArray(row) && row.length >= 2).slice(0, 12)
    }))
    .filter((table) => table.rows.length);
}

function isEmptyObject(value) {
  return !value || typeof value !== "object" || Object.keys(value).length === 0;
}

// 사진 원본을 그대로 중계한다. 크롤러 API 주소와 인증 키를 브라우저에 노출하지 않기 위함.
export async function proxyCourtAuctionAsset(params, response) {
  const id = String(params.get("id") || "").trim();
  const objectKey = String(params.get("key") || "").trim();
  const baseUrl = courtDetailBaseUrl();

  if ((!id && !objectKey) || !baseUrl) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  // DB가 있는 로컬 크롤러는 id로, 객체 스토리지로 서비스되는 배포판은 object_key로
  // 찾는다. 어느 쪽이 살아 있는지 환경마다 달라서 순서대로 시도한다.
  const candidates = [];
  if (id) candidates.push(`${baseUrl}/api/v1/assets/${encodeURIComponent(id)}`);
  if (objectKey) candidates.push(`${baseUrl}/api/v1/assets/${encodeURIComponent(objectKey)}`);

  try {
    let upstream = null;
    for (const candidate of candidates) {
      const attempt = await fetch(candidate, courtDetailRequestInit());
      if (attempt.ok) {
        upstream = attempt;
        break;
      }
      upstream = attempt;
    }

    if (!upstream || !upstream.ok) {
      const status = upstream ? upstream.status : 404;
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Upstream error");
      return;
    }

    // 객체 스토리지로 서비스되는 환경은 이미지 대신 만료 있는 서명 URL을 JSON으로 준다.
    // 그 URL로 리다이렉트하면 브라우저가 스토리지에서 직접 받는다(중계 대역폭 절약).
    const upstreamType = upstream.headers.get("content-type") || "";
    if (upstreamType.includes("application/json")) {
      const payload = await upstream.json().catch(() => null);
      const signedUrl = payload && typeof payload.url === "string" ? payload.url : "";
      if (!signedUrl) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Bad gateway");
        return;
      }
      response.writeHead(302, {
        Location: signedUrl,
        // 서명 URL은 만료(expires_in)가 있으므로 리다이렉트 자체는 캐시하지 않는다.
        "Cache-Control": "no-store"
      });
      response.end();
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
      // 사진은 내용이 바뀌지 않는다(파일 해시가 곧 id). 오래 캐시해도 안전하다.
      "Cache-Control": "public, max-age=86400"
    });
    response.end(buffer);
  } catch (error) {
    console.error("asset proxy failed", id, error.message);
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad gateway");
  }
}

function courtDetailBaseUrl() {
  const configured = process.env.COURT_AUCTION_API_URL || process.env.COURT_AUCTION_API_BASE_URL;
  if (configured) return String(configured).replace(/\/$/, "");
  return process.env.VERCEL ? "" : "http://127.0.0.1:8000";
}

// 크롤러 API가 키로 잠겨 있을 때만 헤더를 붙인다(로컬 무인증 서버 호환).
function courtDetailRequestInit() {
  const key = process.env.COURT_AUCTION_API_KEY;
  return key ? { headers: { "X-API-Key": key } } : undefined;
}
