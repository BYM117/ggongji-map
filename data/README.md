# 실데이터 반입

이 폴더에 실제 매물 데이터를 넣으면 앱이 `/api/properties`를 통해 자동으로 읽습니다.

지원 파일:

- `data/properties.json`
- `data/onbid.csv`
- `data/court-auction.csv`

CSV 컬럼 예시:

```csv
id,source,caseNo,title,type,region,address,lat,lng,minBid,appraisal,publicLandPricePerSqm,landArea,pnu,bidDate,failCount,risk,zoning,memo,checks
real-1,온비드,2026-001,샘플 토지,토지,경기 파주,경기도 파주시 조리읍 장곡리 128-7,37.7358,126.8097,142000000,291000000,212000,812,4148025021101280007,2026-07-08,2,보통,계획관리지역,실데이터 반입 테스트,공시지가 이하|권리확인 필요
```

필수 컬럼:

- `lat`
- `lng`
- `minBid`

공시지가 비교 정확도를 높이는 컬럼:

- `publicLandPricePerSqm`
- `landArea`
- `pnu`

## 오피스텔·상가 기준시가 인덱스 (`officetel-prices/`)

`data/officetel-prices/{시도코드}.json.gz`는 국세청 상업용건물·오피스텔 기준시가를 시도별로 나눠 gzip으로 저장한 조회 인덱스입니다. `/api/officetel-price`가 PNU로 필지를, 주소의 층/호로 세대를 특정해 기준시가 총액을 계산합니다.

갱신(연 1회, 국세청 고시 후):

1. [공공데이터포털 국세청 기준시가](https://www.data.go.kr/data/3036455/fileData.do)에서 최신 XLSX를 내려받습니다.
2. `pip install openpyxl` 후 아래를 실행하면 `data/officetel-prices/`가 다시 만들어집니다.

```bash
python3 scripts/build-officetel-index.py <내려받은.xlsx>
```

## 공시기준가 사전 계산 (`official-prices.json.gz`)

`data/official-prices.json.gz`는 스냅샷 물건별로 **PNU와 공시기준가를 오프라인에서 미리 계산**해 둔 사이드카입니다. 서버(`lib/official-prices.mjs`)가 로드 시 물건에 덮어씌우므로, 앱은 런타임 API 호출 없이 즉시 공시기준가를 표시합니다. (사이드카에 없는 물건만 클릭 시 on-demand로 조회)

형식: `{ prices: { "물건id": {publicStandardPrice|publicHousingPrice|publicLandPricePerSqm, pnu, ...}}, processed: { "물건id": status } }`

생성/갱신 (스냅샷이 바뀌면 재실행):

```bash
node scripts/enrich-official-prices.mjs           # 전체 (재개 가능, 300건마다 체크포인트)
node scripts/enrich-official-prices.mjs --limit 2000   # 일부만
node scripts/enrich-official-prices.mjs --retry-miss   # 지오코딩/조회 실패분 재시도
```

- 오피스텔·상가는 로컬 기준시가 인덱스라 API 없이 즉시 계산됩니다.
- 아파트·빌라·단독·토지는 VWorld API를 쓰며, PNU가 없는 물건은 먼저 주소 지오코딩으로 PNU를 확보합니다. `VWORLD_API_KEY`가 필요합니다.
- 이미 처리한 물건은 건너뛰므로 중단 후 다시 실행하면 이어서 진행합니다.

대법원경매는 공식 공개 API가 없으므로 우선 CSV/JSON 반입으로 처리합니다. 온비드는 API 문서와 인증키가 준비되면 `.env`에 `ONBID_API_URL`, `ONBID_SERVICE_KEY`를 넣어 서버 프록시에서 연결합니다.

온비드 OpenAPI 연동:

- `.env`에 `ONBID_API_URL`, `ONBID_SERVICE_KEY`를 넣으면 `/api/properties`가 온비드 응답도 함께 읽습니다.
- 별도 점검은 `/api/onbid-properties`에서 합니다.
- 온비드 응답에 좌표가 없으면 지도에 올릴 수 없어 `droppedCount`로 제외 개수가 표시됩니다.
- 좌표 없는 물건은 다음 단계에서 주소 지오코딩을 붙여 보강합니다.
