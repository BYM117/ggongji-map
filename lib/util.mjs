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

export async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
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
