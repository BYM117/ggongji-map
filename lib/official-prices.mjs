import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";

const root = resolve(".");

// 오프라인으로 사전 계산한 공시가격 사이드카를 한 번만 읽어 물건 id → 패치로 보관한다.
let indexPromise = null;

function loadIndex() {
  if (indexPromise) return indexPromise;
  indexPromise = (() => {
    const path = resolve(process.env.OFFICIAL_PRICES_PATH || join(root, "data/official-prices.json.gz"));
    try {
      const payload = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
      return payload.prices || {};
    } catch {
      return {};
    }
  })();
  return indexPromise;
}

// 물건 정규화 결과에 사전 계산 공시가격을 덮어씌운다. 이미 값이 있으면 유지한다.
export function overlayOfficialPrice(property) {
  if (!property?.id) return property;
  const index = loadIndex();
  const patch = index[property.id];
  if (!patch) return property;

  const merged = { ...property };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "pnu" && merged.pnu) continue; // 이미 PNU가 있으면 덮어쓰지 않는다
    merged[key] = value;
  }
  return merged;
}
