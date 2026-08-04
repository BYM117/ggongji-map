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
import { fetchSeoulDeals } from "./lib/seoul.mjs";
import { fetchOnbid, fetchOnbidProperties, fetchOnbidViewportProperties, onbidEndpoint } from "./lib/onbid.mjs";
import {
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
      const payload = await fetchLandPrice(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
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
      const payload = await fetchHousingPrice(url.searchParams);
      sendJson(response, payload.ok ? 200 : 400, payload);
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

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store, max-age=0",
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
