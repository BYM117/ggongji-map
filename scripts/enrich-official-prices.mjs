// 스냅샷 물건에 대해 PNU·공시기준가를 오프라인으로 사전 계산해 사이드카에 저장한다.
// 결과: data/official-prices.json.gz  ({ prices: { id: {패치} }, processed: { id: status } })
// 서버(lib/official-prices.mjs)가 이 파일을 읽어 물건에 덮어씌우므로, 앱은 런타임 API 없이 공시기준가를 갖는다.
//
// 사용법:
//   node scripts/enrich-official-prices.mjs [--limit N] [--retry-miss] [--concurrency 6]
// 재개: 이미 처리한 id는 건너뛴다. --retry-miss는 지오코딩/조회 실패분을 다시 시도한다.
//
// VWORLD_API_KEY(.env)가 필요하다. 오피스텔은 로컬 인덱스라 API 없이 즉시 계산된다.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { classifyOfficialKind, computeOfficialFields } from "../lib/official.mjs";
import { cleanAuctionAddress } from "../lib/geo.mjs";
import { numberFrom } from "../lib/util.mjs";

const root = resolve(".");
loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const limit = args.limit ? Number(args.limit) : Infinity;
const concurrency = args.concurrency ? Number(args.concurrency) : 6;
const retryMiss = Boolean(args["retry-miss"]);
const year = args.year ? Number(args.year) : new Date().getFullYear();

const snapshotPath = resolve(process.env.COURT_AUCTION_SNAPSHOT_PATH || join(root, "data/court-auctions.snapshot.json"));
const outPath = resolve(process.env.OFFICIAL_PRICES_PATH || join(root, "data/official-prices.json.gz"));

const items = loadSnapshot(snapshotPath);
const state = loadCheckpoint(outPath);
const counts = { priced: 0, geocode_miss: 0, price_miss: 0, skip_kind: 0, error: 0, resumed: Object.keys(state.processed).length };

const pending = items
  .map(toTask)
  .filter((task) => task.kind !== "mixed") // 공시가격 원천이 없는 유형은 제외
  .filter((task) => {
    const prev = state.processed[task.id];
    if (!prev) return true;
    if (retryMiss && (prev === "geocode_miss" || prev === "price_miss" || prev === "error")) return true;
    return false;
  })
  // 비용 낮고 생산적인 것부터: 오피스텔(로컬)·PNU 보유(지오코딩 불필요) 우선, 지오코딩 필요분 나중
  .sort((a, b) => taskCost(a) - taskCost(b))
  .slice(0, limit === Infinity ? undefined : limit);

console.log(`대상 ${items.length}개 중 처리 ${pending.length}개 (이미 처리 ${counts.resumed}개), 동시성 ${concurrency}`);

let processed = 0;
let sinceCheckpoint = 0;
const started = Date.now();

await runPool(pending, concurrency, async (task) => {
  try {
    const result = await computeOfficialFields({ ...task, year });
    state.processed[task.id] = result.status;
    counts[result.status] = (counts[result.status] || 0) + 1;
    if (Object.keys(result.patch).length) state.prices[task.id] = result.patch;
  } catch (error) {
    state.processed[task.id] = "error";
    counts.error += 1;
    if (counts.error <= 5) console.warn("오류", task.id, error.message);
  }
  processed += 1;
  sinceCheckpoint += 1;
  if (sinceCheckpoint >= 300) {
    writeCheckpoint(outPath, state);
    sinceCheckpoint = 0;
    const rate = processed / ((Date.now() - started) / 1000);
    console.log(`  진행 ${processed}/${pending.length} · 매칭 ${counts.priced} · ${rate.toFixed(1)}건/s`);
  }
});

writeCheckpoint(outPath, state);
console.log(
  `완료: 처리 ${processed}, 매칭 ${counts.priced}, 지오코딩실패 ${counts.geocode_miss || 0}, 조회실패 ${counts.price_miss || 0}, 대상외 ${counts.skip_kind || 0}, 오류 ${counts.error}`
);
console.log(`저장: ${outPath} (총 ${Object.keys(state.prices).length}개 물건 공시가격)`);

function toTask(item) {
  const property = item.property || {};
  const addressObj = property.address || {};
  const area = property.area || {};
  const address = cleanAuctionAddress(addressObj.raw || item.address || "");
  const cleanAddress = cleanAuctionAddress(addressObj.clean || item.address || "");
  const kind = classifyOfficialKind({
    category: property.category || item.category || "",
    typeGuess: property.type_guess || "",
    address
  });
  return {
    id: item.id,
    kind,
    pnu: String(item.pnu || "").trim(),
    address,
    cleanAddress,
    landArea: numberFrom(area.land_sqm || area.total_sqm) || 0
  };
}

function taskCost(task) {
  if (task.kind === "mixed") return 0;
  if (task.kind === "officetel") return task.pnu ? 1 : 2;
  return task.pnu ? 3 : 4; // 지오코딩 필요분이 가장 비쌈
}

async function runPool(tasks, size, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      await worker(task);
    }
  });
  await Promise.all(runners);
}

function loadSnapshot(path) {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.items || [];
  return rows.filter((row) => row && row.id);
}

function loadCheckpoint(path) {
  try {
    const payload = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
    return { prices: payload.prices || {}, processed: payload.processed || {} };
  } catch {
    return { prices: {}, processed: {} };
  }
}

function writeCheckpoint(path, data) {
  const payload = {
    source: "국토부 공시가격 + 국세청 기준시가 사전계산",
    generatedAt: new Date().toISOString(),
    prices: data.prices,
    processed: data.processed
  };
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function loadDotEnv() {
  try {
    readFileSync(join(root, ".env"), "utf8")
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
        const [key, ...rest] = trimmed.split("=");
        if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
      });
  } catch {}
}
