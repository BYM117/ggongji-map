import { access } from "node:fs/promises";

export function numberFrom(value) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return 0;
  const normalized = String(value).replace(/[^0-9.-]/g, "");
  return Number(normalized) || 0;
}

export function cleanText(value) {
  return String(value || "").trim();
}

// 온비드 날짜는 "202701041400"(연월일시분) 꼴 문자열이다. 지금 시각을 같은 모양으로 만들어야
// 문자열 비교만으로 "이 회차가 지났나"를 볼 수 있다. 목록(lib/onbid.mjs)과 상세
// (lib/onbid-detail.mjs)가 같은 판정을 하므로 형식은 여기 한 곳에만 둔다.
export function onbidStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes())
  );
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

export function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && String(object[key]).trim() !== "") {
      return object[key];
    }
  }
  return "";
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    results.push(...(await Promise.all(chunk.map(mapper))));
  }
  return results;
}

export async function fetchJson(url, options, { throwOnHttpError = false } = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (throwOnHttpError && !response.ok) throw httpError(response.status, text);

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

// HTTP 오류 상태는 "성공"이 아니다. 값으로 넘기면 재시도도 폴백도 걸리지 않는다.
//
// 실측: VWorld 가 502 + HTML 본문을 주면 JSON.parse 만 실패해서 {text:"<html>…"} 가
// 정상 반환됐다. 예외가 아니므로 아래 재시도 루프가 돌지 않았고(attempts:3 으로 두어도
// fetch 는 1번), withUpstreamFallback 도 예외를 잡는 것이라 비켜갔다.
// 그대로 통과해 fetchLandPrice 가 {ok:true, pricePerSqm:null} 을 돌려줬다 —
// docs/TODO-배포-공매-0건.md 가 "ok:true 는 성공이 아니다"로 남긴 것이 이것이다.
function httpError(status, text) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.body = String(text || "").slice(0, 200);
  // 상대 쪽 일시 장애와 한도 초과만 다시 물어볼 값어치가 있다. 400·404 는 다시 물어도 같다.
  error.retryable = status >= 500 || status === 429 || status === 408;
  return error;
}

// 배포 환경에서 외부 API로 나가는 요청이 간헐적으로 끊긴다(실측: 5회 중 3회 실패).
// 한 번의 일시적 실패가 그대로 500이 되지 않도록 짧게 재시도한다. 그래도 안 되면
// 던지되, 호출부가 잡아서 사용자에게는 "잠시 후 다시"로 보여준다.
export async function fetchJsonRetry(url, options, { attempts = 3, delayMs = 200, timeoutMs = 0 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // fetch 는 기본 시간 제한이 없다. 상대가 응답을 안 주면 그대로 매달려서
      // 함수 실행 제한(30초)까지 끌려가고, 화면은 아무것도 못 받는다.
      // 신호는 시도마다 새로 만든다. 하나를 돌려 쓰면 첫 시도에서 끊긴 신호로 재시도한다.
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
      // 여기서만 HTTP 오류를 예외로 올린다. fetchJson 을 직접 쓰는 법원·온비드·서울시
      // 경로는 응답 본문의 오류 코드를 스스로 읽고 있어서 건드리면 동작이 바뀐다.
      return await fetchJson(url, signal ? { ...options, signal } : options, { throwOnHttpError: true });
    } catch (error) {
      lastError = error;
      // 다시 물어도 같은 답이 오는 오류(400·404 등)는 남은 시도를 쓰지 않는다.
      if (error?.retryable === false) break;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

export function parseQueryString(value) {
  const params = new URLSearchParams();
  String(value || "")
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .forEach((pair) => {
      const [key, ...rest] = pair.split("=");
      if (key) params.set(decodeURIComponent(key), decodeURIComponent(rest.join("=") || ""));
    });
  return params;
}

export function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return rows;
  const headers = splitCsvLine(lines[0]);

  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];
    if (char === "\"" && inQuotes && nextChar === "\"") {
      value += "\"";
      index += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value.trim());
  return values;
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// 오래 떠 있는 서버에서 캐시가 무한히 자라지 않도록 오래된 항목부터 밀어낸다.
export function putBoundedMap(map, key, value, max = 20000) {
  if (!map.has(key) && map.size >= max) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

export function addBoundedSet(set, value, max = 50000) {
  if (!set.has(value) && set.size >= max) {
    set.delete(set.values().next().value);
  }
  set.add(value);
}
