// 공매(온비드) 물건 상세 — 사진·감정평가·등기권리·임대차·회차 일정.
//
// 목록(onbid.mjs)은 지도에 점을 찍는 데 필요한 최소한만 받는다. 상세는 물건을 눌렀을 때만
// 필요하고 응답도 훨씬 커서(한 물건에 회차 행이 10개씩 붙는다) 별도 모듈로 뗐다.
// 법원 쪽 lib/court-detail.mjs와 짝을 이루는 자리다.

import { fetchJson, putBoundedMap } from "./util.mjs";

const DEFAULT_DETAIL_ENDPOINT = "https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2";

// 첨부(사진·감정평가서)는 온비드가 attachment + nosniff + octet-stream으로 내려준다.
// 그대로 <img src>에 걸면 브라우저가 스니핑을 거부해서 그림이 뜨지 않는다. 반드시 이쪽을
// 거쳐 Content-Type을 바로잡아 다시 내보낸다. 호스트를 여기 한 곳에 고정해 두는 이유는
// url 파라미터를 그대로 fetch하면 서버가 아무 주소나 대신 긁어주는 통로(SSRF)가 되기 때문이다.
const ALLOWED_ASSET_HOSTS = new Set(["www.onbid.co.kr", "onbid.co.kr", "m.onbid.co.kr"]);

// 상세는 공고가 끝날 때까지 거의 바뀌지 않는다. 같은 물건을 다시 열 때 왕복을 없앤다.
const detailCache = new Map();

export function onbidDetailEndpoint() {
  const configured = process.env.ONBID_DETAIL_API_URL;
  const base = String(configured || DEFAULT_DETAIL_ENDPOINT).replace(/\/$/, "");
  return base.endsWith("/getRlstDtlInf2") ? base : `${base}/getRlstDtlInf2`;
}

export async function fetchOnbidDetail(params) {
  const id = String(params.get("id") || params.get("cltrMngNo") || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey) {
    return { ok: false, error: "onbid_api_not_configured", message: "ONBID_SERVICE_KEY가 설정되지 않았습니다." };
  }

  if (detailCache.has(id)) return detailCache.get(id);

  const url = new URL(onbidDetailEndpoint());
  url.searchParams.set(process.env.ONBID_SERVICE_KEY_PARAM || "serviceKey", serviceKey);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("cltrMngNo", id);
  // 회차 행이 물건 하나에 수십 개 붙을 수 있다. 한 번에 다 받아야 일정이 끊기지 않는다.
  url.searchParams.set("numOfRows", "100");
  url.searchParams.set("pageNo", "1");

  let payload = null;
  try {
    payload = await fetchJson(url);
  } catch (error) {
    console.error("onbid detail fetch failed", id, error.message);
    return { ok: false, error: "onbid_api_unreachable" };
  }

  const header = payload?.response?.header || payload?.header || {};
  const code = String(header.resultCode ?? "");
  // 정상은 "00" 또는 "0". 키 만료·한도 초과가 200 본문으로 오므로 여기서 걸러야 한다.
  if (code && code !== "00" && code !== "0") {
    return { ok: false, error: "onbid_api_error", code, message: header.resultMsg || "" };
  }

  const rows = extractRows(payload);
  if (!rows.length) return { ok: false, error: "not_found" };

  const result = { ok: true, detail: normalizeOnbidDetail(id, rows) };
  putBoundedMap(detailCache, id, result, 500);
  return result;
}

function extractRows(payload) {
  const candidate =
    payload?.response?.body?.items?.item ??
    payload?.body?.items?.item ??
    payload?.response?.body?.items ??
    payload?.body?.items;
  if (Array.isArray(candidate)) return candidate.filter(Boolean);
  return candidate ? [candidate] : [];
}

// 응답 행 하나하나가 "물건 × 입찰 회차"다. 물건 정보는 모든 행에 똑같이 복사돼 있고
// 회차마다 다른 것은 입찰 기간과 최저입찰가뿐이다. 그래서 물건은 첫 행에서 뽑고,
// 회차는 전체 행에서 모은다.
function normalizeOnbidDetail(id, rows) {
  const head = rows[0] || {};
  const rounds = buildRounds(rows);
  const appraisalAmount = numberOrNull(head.apslEvlAmt);

  return {
    id,
    source: "onbid",
    caseNo: text(head.cltrMngNo) || id,
    title: text(head.onbidCltrNm),
    category: [head.cltrUsgMclsCtgrNm, head.cltrUsgSclsCtgrNm].map(text).filter(Boolean).join(" · "),
    // 지번(zadrNm)과 도로명(cltrRadr)이 따로 온다. 목록에는 지번만 있어서 도로명은 여기서만 본다.
    address: { lot: text(head.zadrNm), road: text(head.cltrRadr) },
    org: {
      agency: text(head.orgNm),           // 한국자산관리공사 등 집행기관
      requester: text(head.rqstOrgNm),    // 강서세무서 등 위임기관
      disposal: text(head.dspsMthodNm),
      bidType: text(head.bidDivNm),
      propertyDiv: text(head.prptDivNm)   // 압류재산 / 국유재산 …
    },
    appraisalAmount,
    firstNoticeDate: text(head.frstPbancYmd),
    distributionDeadline: text(head.dtbtRqrEdtmCont),
    photos: buildPhotos(head),
    areas: buildAreas(head.sqmsList),
    appraisals: buildAppraisals(head.apslEvlClgList),
    rights: buildRights(head.rgstPrmrInfList),
    tenants: buildTenants(head.leasInfList),
    notes: buildNotes(head),
    rounds
  };
}

// 회차 번호(pbctNsq)는 새 공고가 붙으면 001로 되돌아간다. 실제 순서는 입찰 시작일이 쥐고 있다.
// 번호로 정렬하면 최저가가 올라갔다 내려갔다 하는 엉터리 일정이 나온다.
//
// 상태는 API 값을 쓰지 않는다. 상세 응답의 pbctStatNm에는 이름이 아니라 코드가 그대로
// 들어 있다("0001"). 같은 이름의 목록 API 필드는 "입찰준비중"을 주므로 둘이 어긋난다.
// 코드표가 공개돼 있지 않아 추측해 옮기느니, 마감일과 오늘을 비교해 직접 정한다.
function buildRounds(rows, now = new Date()) {
  const seen = new Set();
  const stamp = toStamp(now);

  return rows
    .map((row) => {
      const start = text(row.cltrBidBgngDt);
      const end = text(row.cltrBidEndDt);
      return {
        seq: text(row.pbctNsq),
        start,
        end,
        price: numberOrNull(row.lowstBidPrcIndctCont),
        phase: end && end < stamp ? "past" : start && start > stamp ? "upcoming" : "open"
      };
    })
    .filter((round) => {
      if (!round.start || !round.price) return false;
      const key = `${round.start}|${round.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

// 온비드 날짜는 "202701041400" 꼴이다. 같은 모양으로 만들어야 문자열 비교가 성립한다.
function toStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes())
  );
}

// 사진 URL은 downloadImageKind=THNL_NM이 붙어 있으면 8KB짜리 썸네일, 떼면 1MB 원본이 온다.
// 목록 줄에는 썸네일을, 크게 보기에는 원본을 쓰려고 두 벌을 만들어 둔다.
function buildPhotos(head) {
  const photos = [];
  const push = (url, label) => {
    const clean = text(url);
    if (!clean || photos.some((photo) => photo.url === clean)) return;
    photos.push({
      url: assetPath(clean, "thumb"),
      fullUrl: assetPath(clean, "full"),
      label
    });
  };

  for (const entry of asArray(head.potoUrlList)) {
    push(typeof entry === "string" ? entry : entry?.urlAdr, "현장 사진");
  }
  // 이름은 List인데 실제로는 파이프로 이어 붙인 문자열 하나로 온다. 배열로 착각하면 통째로 날아간다.
  for (const url of splitPipe(head.lrmUrlAdrList)) push(url, "도면·위치도");
  for (const entry of asArray(head.poto360DgrUrlList)) {
    push(typeof entry === "string" ? entry : entry?.urlAdr, "360° 사진");
  }

  return photos;
}

// 온비드는 같은 내용을 두 번 실어 보내는 일이 잦다(감정평가서 한 건이 첨부번호만 다르게
// 두 줄, 전입세대주 한 사람이 두 줄). 화면에서 같은 줄이 겹쳐 보이므로 값으로 걸러낸다.
function dedupe(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAreas(list) {
  const areas = asArray(list)
    .map((row) => ({
      kind: text(row?.clandCont),      // "토지>대", "건물>건물"
      size: text(row?.sqmsCont),
      note: text(row?.dtlCltrNm)       // 지분 매각이면 여기에 "지분(총면적 …)"이 적혀 온다
    }))
    .filter((area) => area.kind || area.size);
  return dedupe(areas, (a) => `${a.kind}|${a.size}|${a.note}`);
}

function buildAppraisals(list) {
  const appraisals = asArray(list)
    .map((row) => ({
      date: text(row?.apslEvlYmd),
      org: text(row?.apslEvlOrgNm),
      amount: numberOrNull(row?.apslEvlAmt),
      url: text(row?.urlAdr) ? assetPath(text(row.urlAdr), "full") : ""
    }))
    .filter((item) => item.org || item.amount || item.url);
  // 첨부 파일 번호만 다르고 평가일·기관·금액이 같으면 같은 감정평가서다.
  return dedupe(appraisals, (a) => `${a.date}|${a.org}|${a.amount}`);
}

function buildRights(list) {
  const rights = asArray(list)
    .map((row) => ({
      kind: text(row?.irstDivNm),      // 가압류 / 근저당권 / 위임기관 …
      holder: text(row?.cltrInprNm),
      date: text(row?.rgstYmd),
      amount: numberOrNull(row?.inprStngAmt)
    }))
    .filter((right) => right.kind || right.holder);
  return dedupe(rights, (r) => `${r.kind}|${r.holder}|${r.date}|${r.amount}`);
}

function buildTenants(list) {
  const tenants = asArray(list)
    .map((row) => ({
      kind: text(row?.irstDivNm),      // 전입세대주 / 임차인 …
      name: text(row?.cltrInprNm),
      deposit: numberOrNull(row?.bidGrteeAmt) ?? numberOrNull(row?.convGrteeAmt),
      monthly: numberOrNull(row?.mthrAmt),
      moveInDate: text(row?.mvinYmd),
      confirmDate: text(row?.cfmtnYmd)
    }))
    .filter((tenant) => tenant.kind || tenant.name);
  return dedupe(tenants, (x) => `${x.kind}|${x.name}|${x.moveInDate}|${x.deposit}`);
}

// 온비드가 주는 현황 설명들. 같은 문장이 부대조건과 납부주의사항에 그대로 복사돼 오는 일이
// 잦아서(실측: 표본 10건 중 2건) 본문이 겹치면 하나만 남긴다.
function buildNotes(head) {
  const candidates = [
    { title: "위치 및 부근 현황", body: text(head.locVntyPscdCont) },
    { title: "이용 현황", body: text(head.utlzPscdCont) },
    { title: "부대조건", body: text(head.icdlCdtnCont) },
    { title: "입찰 시 주의사항", body: text(head.pytnMtrsCont) },
    { title: "기타", body: text(head.cltrEtcCont) }
  ];

  const notes = [];
  for (const note of candidates) {
    if (!note.body) continue;
    if (notes.some((kept) => kept.body === note.body)) continue;
    notes.push(note);
  }
  return notes;
}

// 첨부는 우리 서버를 거쳐 나간다. 브라우저가 받는 주소는 원본이 아니라 이 경로다.
function assetPath(url, size) {
  return `/api/onbid-asset?size=${size}&url=${encodeURIComponent(url)}`;
}

export async function proxyOnbidAsset(params, response) {
  const raw = String(params.get("url") || "").trim();
  const size = String(params.get("size") || "full");

  let target = null;
  try {
    target = new URL(raw);
  } catch {
    target = null;
  }

  // 호스트를 확인하지 않으면 이 경로가 "아무 주소나 서버가 대신 받아다 주는" 통로가 된다.
  if (!target || (target.protocol !== "https:" && target.protocol !== "http:") || !ALLOWED_ASSET_HOSTS.has(target.hostname)) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad asset url");
    return;
  }

  if (size === "full") target.searchParams.delete("downloadImageKind");
  else target.searchParams.set("downloadImageKind", "THNL_NM");

  try {
    const upstream = await fetch(target, { redirect: "follow" });
    if (!upstream.ok) {
      response.writeHead(upstream.status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Upstream error");
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    // 온비드는 무엇이든 octet-stream으로 준다. 내용 앞머리를 보고 우리가 직접 정해 준다.
    // 여기서 image/jpeg로 바로잡지 않으면 nosniff 때문에 <img>가 그림을 그리지 않는다.
    response.writeHead(200, {
      "Content-Type": sniffContentType(buffer),
      "Content-Length": buffer.length,
      // 첨부 지정을 떼야 사진이 다운로드가 아니라 화면에 뜬다.
      "Cache-Control": "public, max-age=3600"
    });
    response.end(buffer);
  } catch (error) {
    console.error("onbid asset proxy failed", error.message);
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Upstream error");
  }
}

function sniffContentType(buffer) {
  const head = buffer.subarray(0, 4).toString("hex");
  if (head.startsWith("ffd8ff")) return "image/jpeg";
  if (head === "89504e47") return "image/png";
  if (head === "25504446") return "application/pdf";
  if (head.startsWith("47494638")) return "image/gif";
  return "application/octet-stream";
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined);
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function splitPipe(value) {
  return String(value ?? "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function text(value) {
  if (value === null || value === undefined) return "";
  const cleaned = String(value).trim();
  return cleaned === "null" || cleaned === "-" ? "" : cleaned;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}
