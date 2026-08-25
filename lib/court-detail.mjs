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

  return {
    id: raw.id || "",
    caseNo: (raw.case || {}).display_case_no || raw.case_no || "",
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
      buildingSqm: area.building_sqm || null
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
      status: auction.status || raw.status || "",
      failCount: auction.fail_count ?? null,
      isActive: auction.is_active !== false,
      detailUrl: auction.detail_url || raw.detail_url || ""
    },
    screening: {
      score: screening.score ?? null,
      riskLevel: screening.risk_level || "",
      flags: Array.isArray(screening.flags) ? screening.flags : []
    },
    building: isEmptyObject(raw.building) ? null : raw.building,
    transactions: isEmptyObject(raw.transactions) ? null : raw.transactions,
    photos: normalizePhotos(raw.assets),
    documents: normalizeDocuments(raw.documents),
    caseTables: normalizeCaseTables(raw.detail),
    detailStatus: raw.detail_status || "",
    detailCollectedAt: raw.detail_collected_at || ""
  };
}

function normalizePhotos(assets) {
  if (!Array.isArray(assets)) return [];
  return assets
    .filter((asset) => asset && asset.kind === "photo" && asset.id)
    .map((asset) => ({
      id: asset.id,
      label: asset.label || "",
      // 크롤러 API를 직접 노출하지 않고 꽁지맵 프록시를 거친다.
      url: `/api/court-auction-asset?id=${encodeURIComponent(asset.id)}`
    }));
}

function normalizeDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter((doc) => doc && doc.document_type)
    .map((doc) => ({
      type: doc.document_type,
      status: doc.status || "",
      sourceUrl: doc.source_url || "",
      // 문서 본문은 metadata.iframe.text에 들어 있다. 길어서 앞부분만 미리보기로 쓴다.
      preview: extractDocumentText(doc).slice(0, 600)
    }));
}

function extractDocumentText(doc) {
  const iframe = ((doc.metadata || {}).iframe) || {};
  return String(iframe.text || "").replace(/\s+/g, " ").trim();
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
  const baseUrl = courtDetailBaseUrl();

  if (!id || !baseUrl) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const upstream = await fetch(`${baseUrl}/api/v1/assets/${encodeURIComponent(id)}`, courtDetailRequestInit());
    if (!upstream.ok) {
      response.writeHead(upstream.status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Upstream error");
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
