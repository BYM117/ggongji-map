import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { numberFrom, putBoundedMap } from "./util.mjs";
import { parseUnitFromAddress } from "./vworld.mjs";

const root = resolve(".");

// 시도별 gzip 샤드를 지연 로딩한다. 뷰포트는 대개 한 시도 안이라 소수만 캐시하면 충분하다.
const shardCache = new Map();

// PNU+주소 → 용도("officetel" / "retail" / "") 조회 결과.
const kindCache = new Map();

// 국세청 상업용건물/오피스텔 기준시가 조회.
// PNU(법정동10 + 필지구분1 + 본번4 + 부번4)로 파셀을 찾고, 주소의 층/호로 세대를 특정한다.
export async function fetchOfficetelPrice(params) {
  const pnu = String(params.get("pnu") || "").trim();
  if (!/^\d{19}$/.test(pnu)) return { ok: false, error: "invalid_pnu" };

  const shard = await loadShard(pnu.slice(0, 2));
  if (!shard) {
    return { ok: true, source: "오피스텔·상가 기준시가", pnu, price: null, matchedCount: 0, message: "해당 지역 기준시가 데이터가 없습니다." };
  }

  const key = `${pnu.slice(0, 10)}:${pnu.slice(11, 15)}:${pnu.slice(15, 19)}`;
  const raw = shard.parcels[key];
  if (!raw) {
    return { ok: true, source: "오피스텔·상가 기준시가", pnu, price: null, matchedCount: 0, message: "해당 필지의 기준시가가 없습니다." };
  }

  const records = raw.split(";").map(parseRecord);
  const unit = resolveUnit(params);
  const match = pickUnit(records, unit);

  if (!match) {
    return {
      ok: true,
      source: "오피스텔·상가 기준시가",
      pnu,
      price: null,
      matchedCount: 0,
      totalCount: records.length,
      requestedUnit: unit,
      message: unit.ho ? "층/호가 일치하는 세대를 찾지 못했습니다." : "주소에서 호수를 읽지 못했습니다."
    };
  }

  const price = Math.round(match.unitPrice * (match.exclusiveArea + match.sharedArea));
  return {
    ok: true,
    source: match.kind === "O" ? "오피스텔 기준시가" : "상업용건물 기준시가",
    pnu,
    price,
    matched: {
      dong: match.dong || "",
      floor: match.floor || "",
      ho: match.ho || "",
      exclusiveArea: match.exclusiveArea || null,
      unitPrice: match.unitPrice || null
    },
    matchedCount: 1,
    totalCount: records.length
  };
}

// 같은 인덱스에서 "이 호실이 오피스텔이냐 상가냐"만 뽑는다.
// 기준시가 금액은 필요 없고 용도만 알면 되는 분류 단계에서 쓴다.
// (국세청 인덱스는 상업용건물·오피스텔만 담고 있어서, 못 찾았다고 주거용이라는 뜻은 아니다.
//  그래서 실패는 ""로 돌려주고 판단을 미룬다.)
export async function lookupOfficetelKind({ pnu, address }) {
  const code = String(pnu || "").trim();
  if (!/^\d{19}$/.test(code)) return "";

  // 뷰포트 요청은 지도를 조금만 움직여도 다시 날아오고, 그때마다 같은 물건을 또 조회한다.
  // 결과는 PNU+주소만으로 정해지므로 한 번 구한 값을 재사용한다.
  const cacheKey = `${code}|${address || ""}`;
  if (kindCache.has(cacheKey)) return kindCache.get(cacheKey);

  const kind = await readOfficetelKind(code, address);
  putBoundedMap(kindCache, cacheKey, kind, 40000);
  return kind;
}

async function readOfficetelKind(code, address) {
  const shard = await loadShard(code.slice(0, 2));
  if (!shard) return "";

  const raw = shard.parcels[`${code.slice(0, 10)}:${code.slice(11, 15)}:${code.slice(15, 19)}`];
  if (!raw) return "";

  const params = new URLSearchParams();
  if (address) params.set("address", address);
  const match = pickUnit(raw.split(";").map(parseRecord), resolveUnit(params));
  if (!match) return "";
  return match.kind === "O" ? "officetel" : "retail";
}

async function loadShard(sido) {
  if (shardCache.has(sido)) return shardCache.get(sido);

  const promise = (async () => {
    const path = join(root, "data/officetel-prices", `${sido}.json.gz`);
    try {
      const compressed = await readFile(path);
      return JSON.parse(gunzipSync(compressed).toString("utf8"));
    } catch {
      return null;
    }
  })();

  // 실패는 캐시에 남기지 않는다. 성공한 샤드는 소수만 유지한다(뷰포트 지역성).
  promise.then((value) => {
    if (!value) shardCache.delete(sido);
  });
  putBoundedMap(shardCache, sido, promise, 4);
  return promise;
}

function parseRecord(record) {
  const [kind, dong, floor, ho, price, exclusive, shared] = record.split("|");
  return {
    kind,
    dong,
    floor,
    ho,
    unitPrice: numberFrom(price),
    exclusiveArea: numberFrom(exclusive),
    sharedArea: numberFrom(shared)
  };
}

function resolveUnit(params) {
  const explicitHo = normalizeToken(params.get("ho"));
  const parsed = parseUnitFromAddress(params.get("address") || "");
  const floor = normalizeToken(params.get("floor")) || parseFloor(params.get("address") || "");
  return {
    dong: normalizeToken(params.get("dong")) || parsed.dong,
    floor,
    ho: explicitHo || parsed.ho
  };
}

function pickUnit(records, unit) {
  if (!unit.ho) return null;

  let candidates = records.filter((record) => digits(record.ho) === digits(unit.ho));
  if (!candidates.length) return null;

  if (candidates.length > 1 && unit.floor) {
    const byFloor = candidates.filter((record) => normalizeToken(record.floor) === unit.floor);
    if (byFloor.length) candidates = byFloor;
  }

  if (candidates.length > 1 && unit.dong) {
    const byDong = candidates.filter((record) => record.dong && digits(record.dong) === digits(unit.dong));
    if (byDong.length) candidates = byDong;
  }

  if (candidates.length === 1) return candidates[0];

  // 여러 세대가 남아도 기준시가가 모두 같으면 안전하게 채택한다.
  const prices = new Set(candidates.map((record) => record.unitPrice));
  return prices.size === 1 ? candidates[0] : null;
}

function parseFloor(address) {
  const text = String(address || "").replace(/\[[^\]]*]/g, " ");
  const matches = [...text.matchAll(/(지하)?\s*(\d+)\s*층/g)];
  if (!matches.length) return "";
  const last = matches[matches.length - 1];
  return (last[1] ? "B" : "") + last[2];
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^제/, "")
    .replace(/(동|층|호)$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}
