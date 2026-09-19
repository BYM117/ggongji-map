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

// 문서 본문을 통째로 실어 보낸다. 세 문서를 합쳐 3KB 남짓이라, 이 응답에서 차지하는
// 비중이 사건 테이블보다 작다. 상한은 크롤러가 이상한 길이를 줄 때를 위한 안전장치다.
const DOCUMENT_BODY_LIMIT = 20000;

function normalizeDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter((doc) => doc && doc.document_type)
    .map((doc) => {
      const body = extractDocumentText(doc);
      // 읽을 것이 없으면 본문을 아예 비워 보낸다. 화면은 body가 있느냐만 보고
      // "본문 보기"를 달지 법원 사이트로 보낼지 정한다 — 판정을 두 곳에 두지 않는다.
      const readable = hasReadableBody(body);
      return {
        type: doc.document_type,
        status: doc.status || "",
        sourceUrl: doc.source_url || "",
        collectedAt: doc.collected_at || "",
        body: readable ? body.slice(0, DOCUMENT_BODY_LIMIT) : "",
        preview: readable ? documentPreview(body) : ""
      };
    });
}

// 크롤러가 문서 페이지를 받아오긴 했는데 정작 문서가 없는 경우가 있다. 그 줄에까지
// "본문 보기"를 달면 눌렀을 때 껍데기만 뜬다. 실측 40개 물건 · 문서 120건에서 세 가지였다.
//
//   ① 매각물건명세서가 빈 문자열                      3건
//   ② 현황조사서에 "검색결과가 없습니다"만 있음         2건
//   ③ 감정평가서는 사건 헤더 + 협회 안내문뿐           40건 전부 (62~225자)
//      실제 감정평가서는 iframe 안의 PDF라 크롤러가 텍스트를 못 뽑는다.
//      그 줄은 법원 사이트 링크만 내보내는 것이 맞다.
//
// ①②는 내용으로 걸러진다. ③만 길이로 거른다 — 감정평가서 최대가 225자이고,
// ②를 뺀 나머지 실문서는 전부 300자를 넘어서 두 덩어리가 떨어져 있다.
// (길이만으로는 못 가른다: 현황조사서 최소가 204자인데 그게 ② 두 건이다.)
const DOCUMENT_BODY_MIN = 300;
const EMPTY_DOCUMENT_MARK = /검색결과가 없습니다/;

function hasReadableBody(body) {
  if (!body || body.length < DOCUMENT_BODY_MIN) return false;
  return !EMPTY_DOCUMENT_MARK.test(body);
}

// 미리보기 한 줄이 그 문서에서 가장 중요한 칸을 가리키게 한다. 앞머리를 그냥 자르면
// PDF 쪽 표시와 띄어쓴 법원 이름이 나와서, 줄을 하나 쓰고도 아무 말을 안 하게 된다.
//
//   매각물건명세서 → "매각으로 소멸되지 아니하는 것"  = 낙찰자가 떠안는 것
//   현황조사서     → "점유관계"                        = 지금 누가 살고 있나
const PREVIEW_ANCHORS = [
  { heading: /소멸되지\s*(아니하는|않는)\s*것/, label: "인수", empty: "명세서에 기재 없음" },
  { heading: /^점유관계$/, label: "점유", empty: "조사서에 기재 없음" }
];

function documentPreview(body) {
  const lines = body.split("\n");

  for (const anchor of PREVIEW_ANCHORS) {
    const index = lines.findIndex((line) => anchor.heading.test(line));
    if (index < 0) continue;
    // 길이로 거르지 않는다. 현황조사서의 점유관계가 "미상"(두 글자)으로 오는 물건이
    // 흔한데, 그걸 짧다고 건너뛰면 문서가 적어 놓은 것을 안 적었다고 말하게 된다.
    // 표제인지 아닌지는 아래 isDocumentHeading이 가린다.
    const next = lines.slice(index + 1, index + 4).find((line) => line.length > 1);
    // 그 칸이 비어 있으면 바로 다음 표제가 잡힌다. 표제를 내용처럼 보여주면 거짓말이다.
    // "비어 있다"는 것 자체가 정보이므로 그렇게 적는다 — 다만 문서가 그렇게 적었다는
    // 뜻이지 실제로 인수할 권리가 없다는 보증은 아니라서, 주어를 문서로 둔다.
    const value = next && !isDocumentHeading(next) ? next : anchor.empty;
    return `${anchor.label} · ${value}`.slice(0, 180);
  }

  return body.slice(0, 180).replace(/\s+/g, " ").trim();
}

// 두 문서의 고정 표제들. 앞 칸이 비면 이 중 하나가 곧바로 따라온다.
const DOCUMENT_HEADINGS =
  /^(매각에 따라|비고란|등기된 부동산|부동산의 표시|최저매각가격|매각물건명세서|<비고>|기타|부동산의 현황|임대차관계 조사서|사진정보)/;

function isDocumentHeading(line) {
  return DOCUMENT_HEADINGS.test(line.trim());
}

// 본문이 어디 들어 있는지가 문서마다 다르다. 실측(2024타경56060):
//
//   매각물건명세서 → metadata.text          2,012자  ← 대항력·인수 여부가 여기 적힌다
//   현황조사서     → metadata.text            924자  ← 점유관계·임대차 조사 결과
//   감정평가서     → metadata.iframe.text      52자  ← "아크로벳을 다운받으세요" 안내문뿐
//
// 예전에는 iframe.text 하나만 봤다. 그래서 정작 내용이 있는 두 문서는 본문이 통째로
// 비었고, 볼 것이 없는 감정평가서만 안내문을 미리보기랍시고 띄우고 있었다. 위 물건의
// 매각물건명세서에는 "매수인에게 대항할 수 있는 주택임차권등기 있음. 배당에서 보증금이
// 전액 변제되지 아니하면 잔액을 매수인이 인수함"과 보증금 4억 7천만원이 적혀 있다.
// 최저입찰가 719만원짜리가 18회 유찰된 이유가 그 문장인데 화면에는 링크만 있었다.
function extractDocumentText(doc) {
  const metadata = doc.metadata || {};
  const raw = String(metadata.text || (metadata.iframe || {}).text || "");
  return collapseDoubleSpacing(cleanDocumentLines(raw));
}

// 원문은 PDF 텍스트 추출이거나 DOM 덤프라서 표 캡션이 "… displayed in the table"로
// 남는다. 사건 테이블 쪽에서 이미 같은 처리를 하고 있다(normalizeCaseTables).
function cleanDocumentLines(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s*displayed in the table\s*/gi, " ").replace(/[ \t]+/g, " ").trim())
    // PDF 텍스트에 쪽 표시("/ 2", "1 / 2")가 한 줄로 섞여 온다. 본문도 미리보기도 아니다.
    .map((line) => (/^\d*\s*\/\s*\d+$/.test(line) ? "" : line))
    // 빈 줄이 연달아 오면 하나로 줄인다.
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join("\n")
    .trim();
}

// PDF 텍스트 추출은 줄마다 빈 줄을 하나씩 끼워 넣는다(매각물건명세서가 그렇다).
// 그대로 두면 본문이 두 배로 길어지고, 진짜 문단 구분과 구별이 안 된다.
// 빈 줄이 절반을 넘으면 그건 문단 구분이 아니라 추출 부산물이다.
function collapseDoubleSpacing(text) {
  const lines = text.split("\n");
  const blanks = lines.filter((line) => !line).length;
  // 경계값으로 재지 말 것. 한 줄 걸러 한 줄이 비면 빈 줄 비율이 딱 절반 언저리인데,
  // 내용 줄이 하나 더 많아서(155줄 중 77줄) "절반 이상"으로도 빠져나간다.
  // 실제로 그 한 줄 차이 때문에 매각물건명세서가 두 줄 간격 그대로 떴다.
  // 문단을 나누려고 넣은 빈 줄이 전체의 40%를 넘는 문서는 없다.
  if (blanks * 5 < lines.length * 2) return text;
  return lines.filter((line) => line).join("\n");
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
