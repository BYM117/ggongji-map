import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { exists, parseCsv } from "./lib/util.mjs";
import { parseViewportBounds } from "./lib/geo.mjs";
import { normalizeProperty } from "./lib/normalize.mjs";
import { fetchGeocode, fetchHousingPrice, fetchLandPrice, fetchParcelBoundary } from "./lib/vworld.mjs";
import { fetchOfficetelPrice } from "./lib/officetel.mjs";
import { fetchCourtAuctionDetail, proxyCourtAuctionAsset } from "./lib/court-detail.mjs";
import { fetchSeoulDeals } from "./lib/seoul.mjs";
import { fetchOnbid, fetchOnbidProperties, fetchOnbidViewportProperties, onbidEndpoint } from "./lib/onbid.mjs";
import {
  fetchCourtAuctionClusters,
  fetchCourtAuctionProperties,
  fetchCourtAuctionViewportProperties,
  searchCourtAuctionProperties
} from "./lib/court.mjs";

const host = process.env.HOST || (process.env.VERCEL ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 4173);
const root = resolve(".");
loadDotEnv();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

export async function handleApiRequest(request, response) {
  const requestHost = request.headers.host || `${host}:${port}`;
  const url = new URL(request.url || "/", `http://${requestHost}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(url, response);
    return;
  }

  sendJson(response, 404, { ok: false, error: "unknown_api" });
}

const server = createServer(async (request, response) => {
  const requestHost = request.headers.host || `${host}:${port}`;
  const url = new URL(request.url || "/", `http://${requestHost}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(url, response);
    return;
  }

  await serveStaticFile(url, response);
});

async function serveStaticFile(url, response) {
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = normalize(join(root, requestedPath));
  const relativePath = relative(root, filePath);

  // 루트 밖 접근(경로 탈출) 차단
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  // .env, .git 같은 숨김 파일/디렉토리와 허용 목록 밖 확장자는 서빙하지 않는다.
  const hasHiddenSegment = relativePath.split(sep).some((segment) => segment.startsWith("."));
  const contentType = contentTypes[extname(filePath)];
  if (hasHiddenSegment || !contentType) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": contentType
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function startServer() {
  server.listen(port, host, () => {
    console.log(`http://${host}:${port}`);
  });
  return server;
}

const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryHref === import.meta.url) {
  startServer();
}

async function handleApi(url, response) {
  try {
    if (url.pathname === "/api/client-config") {
      const naverMapsClientId = String(process.env.NAVER_MAPS_CLIENT_ID || "").trim();
      if (!naverMapsClientId) {
        sendJson(response, 503, { ok: false, error: "missing_naver_maps_client_id" });
        return;
      }
      sendJson(response, 200, { ok: true, naverMapsClientId });
      return;
    }

    if (url.pathname === "/api/properties") {
      const payload = await readExternalProperties();
      sendJson(response, 200, payload);
      return;
    }

    if (url.pathname === "/api/land-price") {
      const payload = await withUpstreamFallback("공시지가", () => fetchLandPrice(url.searchParams));
      sendJson(response, payload.ok ? 200 : payload.status || 400, payload);
      return;
    }

    if (url.pathname === "/api/officetel-price") {
      const payload = await fetchOfficetelPrice(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/geocode") {
      const payload = await fetchGeocode(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/housing-price") {
      const payload = await withUpstreamFallback("공시가격", () => fetchHousingPrice(url.searchParams));
      sendJson(response, payload.ok ? 200 : payload.status || 400, payload);
      return;
    }

    if (url.pathname === "/api/parcel-boundary") {
      const payload = await fetchParcelBoundary(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/seoul-deals") {
      const payload = await fetchSeoulDeals(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/onbid-properties") {
      const payload = await fetchOnbidProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/court-auction-detail") {
      const payload = await fetchCourtAuctionDetail(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/court-auction-asset") {
      await proxyCourtAuctionAsset(url.searchParams, response);
      return;
    }

    if (url.pathname === "/api/court-auctions") {
      const payload = await fetchCourtAuctionProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/search-properties") {
      const payload = await searchCourtAuctionProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/viewport-clusters") {
      const payload = await fetchViewportClusters(url.searchParams);
      // 시·도별 개수는 자주 바뀌지 않는다. CDN이 대신 답하게 두면 크롤러가 자다 깨는
      // 시간을 사용자가 기다리지 않는다(실측: 깨어 있으면 0.4초, 자고 있으면 8.2초).
      // stale-while-revalidate로 만료 뒤에도 일단 옛 값을 주고 뒤에서 새로 받는다.
      const cacheControl =
        payload.mode === "clusters" ? "public, s-maxage=300, stale-while-revalidate=900" : undefined;
      sendJson(response, payload.ok ? 200 : 400, payload, cacheControl);
      return;
    }

    if (url.pathname === "/api/viewport-properties") {
      const payload = await fetchViewportProperties(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    if (url.pathname === "/api/onbid") {
      const payload = await fetchOnbid(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
      return;
    }

    sendJson(response, 404, { ok: false, error: "unknown_api" });
  } catch (error) {
    // 상세 오류는 서버 로그로만 남기고 클라이언트에는 일반화한 메시지를 준다.
    console.error("API error", url.pathname, error);
    sendJson(response, 500, { ok: false, error: "server_error" });
  }
}

// VWorld 호출이 배포 환경에서 간헐적으로 끊긴다. 재시도로도 안 되면 502를 던지는 대신
// 화면이 그 항목만 비우고 계속 돌아가도록 실패를 값으로 돌려준다.
async function withUpstreamFallback(label, run) {
  try {
    return await run();
  } catch (error) {
    console.error(`upstream failed: ${label}`, error?.name || "", String(error?.message || "").slice(0, 120));
    return {
      ok: false,
      error: "upstream_unavailable",
      status: 503,
      message: `${label} 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.`
    };
  }
}

function sendJson(response, status, payload, cacheControl) {
  response.writeHead(status, {
    "Cache-Control": cacheControl || "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readExternalProperties() {
  const sources = [];
  const jsonProperties = await readPropertiesJson();
  const onbidProperties = await readPropertiesCsv("data/onbid.csv", "온비드 CSV");
  const courtProperties = await readPropertiesCsv("data/court-auction.csv", "대법원경매 CSV");
  const liveCourtAuctions = await fetchCourtAuctionProperties(new URLSearchParams({ silent: "1", exactGeocode: "1" }));
  const liveCourtAuctionProperties = liveCourtAuctions.ok ? liveCourtAuctions.properties : [];
  const liveOnbid = await fetchOnbidProperties(new URLSearchParams({ silent: "1" }));
  const liveOnbidProperties = liveOnbid.ok ? liveOnbid.properties : [];
  const properties = [...jsonProperties, ...onbidProperties, ...courtProperties, ...liveCourtAuctionProperties, ...liveOnbidProperties]
    .map(normalizeProperty)
    .filter(Boolean);

  if (jsonProperties.length) sources.push("data/properties.json");
  if (onbidProperties.length) sources.push("data/onbid.csv");
  if (courtProperties.length) sources.push("data/court-auction.csv");
  if (liveCourtAuctionProperties.length) sources.push("법원경매 API");
  if (liveOnbidProperties.length) sources.push("온비드 OpenAPI");

  return {
    ok: true,
    source: sources.length ? sources.join(", ") : "empty",
    properties,
    diagnostics: {
      onbid: {
        configured: Boolean(onbidEndpoint() && process.env.ONBID_SERVICE_KEY),
        fetched: liveOnbid.rawCount || 0,
        mapped: liveOnbid.mappedCount || 0,
        dropped: liveOnbid.droppedCount || 0,
        message: liveOnbid.ok ? liveOnbid.message : liveOnbid.message || null
      },
      courtAuction: {
        configured: Boolean(process.env.COURT_AUCTION_API_URL || process.env.COURT_AUCTION_API_BASE_URL),
        fetched: liveCourtAuctions.rawCount || 0,
        mapped: liveCourtAuctions.mappedCount || 0,
        dropped: liveCourtAuctions.droppedCount || 0,
        message: liveCourtAuctions.ok ? liveCourtAuctions.message : liveCourtAuctions.message || null
      }
    }
  };
}

async function readPropertiesJson() {
  const path = join(root, "data/properties.json");
  if (!(await exists(path))) return [];
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.properties || [];
}

async function readPropertiesCsv(pathFromRoot, sourceName) {
  const path = join(root, pathFromRoot);
  if (!(await exists(path))) return [];
  const rows = parseCsv(await readFile(path, "utf8"));
  return rows.map((row) => ({ ...row, source: row.source || sourceName }));
}

async function fetchViewportProperties(params) {
  const bounds = parseViewportBounds(params);
  if (!bounds) {
    return {
      ok: false,
      error: "missing_bounds",
      message: "swLat, swLng, neLat, neLng가 필요합니다.",
      properties: []
    };
  }

  const sources = String(params.get("sources") || "court,onbid")
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);
  const includeCourt = sources.includes("court") || sources.includes("all");
  const includeOnbid = sources.includes("onbid") || sources.includes("all");
  const exactGeocode = params.get("exactGeocode") !== "0";
  const payloads = [];

  if (includeCourt) {
    payloads.push(fetchCourtAuctionViewportProperties(params, bounds, { exactGeocode }));
  }
  if (includeOnbid) {
    payloads.push(fetchOnbidViewportProperties(params, bounds));
  }

  const results = await Promise.all(payloads);
  const properties = uniqueProperties(results.flatMap((result) => (result.ok ? result.properties : [])))
    .sort((a, b) => compareViewportProperties(a, b));

  return {
    ok: true,
    source: results.filter((result) => result.ok && result.properties.length).map((result) => result.source).join(", ") || "empty",
    message: properties.length ? "현재 지도 화면 안의 경공매 물건을 반환했습니다." : "현재 지도 화면 안에 표시할 물건이 없습니다.",
    properties,
    diagnostics: {
      bounds,
      sources,
      totalCandidateCount: results.reduce((sum, result) => sum + (result.diagnostics?.candidateCount || 0), 0),
      returnedCount: properties.length,
      details: results.map((result) => result.diagnostics || {})
    }
  };
}

// 넓은 화면용. 물건을 하나씩 내려보내는 대신 시·도별 개수만 센다.
// 쪼개야 하는 시·도가 있어 집계로 표현할 수 없으면 needs_detail을 돌려준다 —
// 그때는 호출부가 /api/viewport-properties 로 가야 한다.
async function fetchViewportClusters(params) {
  const bounds = parseViewportBounds(params);
  if (!bounds) {
    return {
      ok: false,
      error: "missing_bounds",
      message: "swLat, swLng, neLat, neLng가 필요합니다.",
      clusters: []
    };
  }

  const payload = await fetchCourtAuctionClusters(params, bounds);
  if (!payload) {
    return {
      ok: true,
      mode: "needs_detail",
      message: "이 화면은 시·군·구까지 나눠 봐야 해서 집계로 답할 수 없습니다.",
      clusters: [],
      diagnostics: { bounds }
    };
  }

  return {
    ...payload,
    mode: "clusters",
    message: payload.clusters.length
      ? "현재 지도 화면의 시·도별 경공매 물건 수입니다."
      : "현재 지도 화면 안에 표시할 물건이 없습니다.",
    diagnostics: { ...(payload.diagnostics || {}), bounds }
  };
}

function uniqueProperties(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function compareViewportProperties(a, b) {
  if (a.source !== b.source) return sourceWeight(a.source) - sourceWeight(b.source);
  return new Date(a.bidDate) - new Date(b.bidDate);
}

function sourceWeight(source) {
  return String(source || "").includes("법원") ? 0 : 1;
}

function loadDotEnv() {
  const path = join(root, ".env");
  try {
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
        const [key, ...rest] = trimmed.split("=");
        if (!process.env[key]) {
          process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
        }
      });
  } catch {}
}
