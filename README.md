# 꽁지맵 MVP

공시지가와 최저입찰가를 비교해 경공매 물건을 선별하고, 주변 실거래 근거를 함께 보는 초기 MVP입니다.

## 구조

- `index.html`, `app.js`, `styles.css`: 프론트엔드 (외부 API 텍스트는 전부 `escapeHtml`로 이스케이프)
- `dev-server.mjs`: HTTP 서버 + API 라우팅 + 정적 파일 서빙 (숨김 파일과 허용 확장자 밖 파일은 서빙하지 않음)
- `lib/util.mjs`: 숫자/CSV/쿼리 파싱, 동시성, 상한이 있는 캐시 헬퍼
- `lib/geo.mjs`: 좌표 추정 테이블(시/도, 시/군/구, 느슨한 매칭)과 뷰포트 경계 계산 — 좌표 테이블은 이 파일에서만 관리
- `categories.js`: 물건 종별 분류(대분류 5 / 세분류 23)와 매각 형태. 서버와 브라우저가 같은 파일을 읽는다
- `lib/normalize.mjs`: 외부 데이터 → 지도용 물건 정규화
- `lib/vworld.mjs`: 개별공시지가, 필지 경계, 주소 지오코딩
- `lib/seoul.mjs`: 서울시 실거래가
- `lib/onbid.mjs`: 온비드 OpenAPI
- `lib/court.mjs`: 법원경매 크롤러 API + 스냅샷
- `api/[...path].mjs`: Vercel 서버리스 진입점 (dev-server의 `handleApiRequest` 재사용)

`npm run dev`와 `npm start` 모두 같은 서버를 띄웁니다.

## 실행

```bash
npm run dev
```

브라우저에서 `http://127.0.0.1:4173`을 엽니다.

법원경매 크롤러 API를 꽁지맵 데이터 소스로 쓰려면 먼저 크롤러 프로젝트에서 API 서버를 실행합니다.

```bash
cd "/Users/bym/Documents/경매물건 크롤링"
PYTHONPATH=src .venv/bin/python -m court_auction_crawler.cli serve \
  --db data/auction.sqlite3 \
  --host 127.0.0.1 \
  --port 8000
```

그 다음 이 프로젝트에서 꽁지맵 서버를 실행합니다.

```bash
cd "/Users/bym/Documents/꽁지맵 개발"
npm run dev
```

꽁지맵 서버는 `/api/court-auctions`에서 `COURT_AUCTION_API_URL`의 `/api/v1/auctions`를 읽고, VWorld 주소검색으로 좌표를 보강한 뒤 지도용 물건 형식으로 변환합니다. 법원경매 API가 꺼져 있거나 결과가 없으면 기존 온비드 로딩으로 fallback합니다.
기본값은 크롤러 DB에 모인 법원 물건 전체(`COURT_AUCTION_ACTIVE=all`)를 훑되, **실좌표(지오코딩 완료) 물건만 지도에 올립니다.** 좌표 미확보 물건은 주소-핀 불일치를 막기 위해 지도에서 제외합니다(크롤러 `geocode-missing`으로 좌표를 채우면 자동 포함).

`index.html` 파일을 직접 더블클릭해서 `file://.../index.html`로 열면 안 됩니다. 브라우저가 모듈 스크립트를 막고, 네이버 지도 허용 도메인도 맞지 않아서 데이터와 지도가 둘 다 깨집니다.

## 배포

### 1차 배포: Vercel 단독 스냅샷 모드

Vercel에는 꽁지맵 Node 서버와 정적 파일을 올립니다. 법원경매 Python API를 따로 배포하지 않아도
`data/court-auctions.snapshot.json.gz`에 저장된 좌표 보강 완료 물건을 읽어 지도에 표시할 수 있습니다.

Vercel 환경변수:

```env
VWORLD_API_KEY=발급받은_VWorld_API_KEY
SEOUL_REAL_ESTATE_API_KEY=서울시_부동산_실거래가_API_KEY
ONBID_SERVICE_KEY=온비드_서비스키
```

법원경매는 Vercel에서 기본적으로 `data/court-auctions.snapshot.json.gz` 스냅샷을 읽습니다. `ONBID_API_URL`, `COURT_AUCTION_SNAPSHOT_PATH`, `ONBID_DEFAULT_QUERY` 같은 공개 고정값은 코드 기본값을 사용합니다.

### 이후 배포: 실시간 법원 API 분리

실시간 크롤링과 DB 갱신이 필요하면 법원경매 크롤러 API를 Railway, Render, Fly.io 같은 Python 웹 서비스에 따로 올립니다.
그 다음 Vercel 환경변수만 아래처럼 바꿉니다.

```env
COURT_AUCTION_API_URL=https://배포된-법원-api-도메인
```

## 네이버 지도

상단의 `Client ID` 입력란에 Naver Maps API `Client ID (X-NCP-APIGW-API-KEY-ID)`를 넣으면 실제 네이버 지도가 로드됩니다. 키가 없을 때는 개발용 좌표 보드가 표시됩니다.

현재 프론트엔드는 Maps JavaScript API만 쓰므로 `ncpKeyId`만 필요합니다. `ncpKey` 또는 Secret Key는 보내지 마세요.

로컬 테스트를 위해 키를 전달하는 방법:

1. 브라우저에서 직접 입력: `http://127.0.0.1:4173` 상단 `Client ID` 입력란에 `X-NCP-APIGW-API-KEY-ID`를 넣고 적용합니다.
2. Codex에게 테스트를 맡기기: 채팅에 `ncpKeyId는 ...` 형태로 알려주면 입력해서 확인합니다. 저장은 브라우저 `localStorage`에만 됩니다.
3. 네이버 클라우드 콘솔에서 Web 서비스 URL에 `http://127.0.0.1:4173`과 `http://localhost:4173`을 허용해 둡니다.

## 물건 종별 분류

`categories.js` 한 곳에서 정한다. 서버(`lib/court.mjs`, `lib/onbid.mjs`, `lib/normalize.mjs`)가 물건에
`categoryGroup` / `categorySub` / `categoryConfident` / `saleForm`을 실어 보내고, 화면은 그 값만 읽는다.

대분류 5개 — 주거 · 상가·업무 · 산업 · 토지 · 기타. 세분류는 그 아래 23개다.

판정 근거의 우선순위는 실제 데이터(활성 물건 36,160건)를 대조해서 정했다.

1. **주소 끝 대괄호의 목록구분** — `[집합건물 ...]` / `[토지 ...]` / `[건물 ...]`. 무엇을 파는지는 여기가 확실하다.
   그대로 `saleForm`(집합건물 / 토지 / 건물만)이 된다.
   대괄호 내용은 공급 API가 `property.address.detail`로 이미 뽑아서 주므로 **그걸 먼저 쓴다**
   (`raw`를 정규식으로 다시 뜯지 않는다 — 원문 표기가 바뀌어도 `detail`은 같은 뜻을 유지한다).
   목록구분은 대괄호 안 첫 단어가 아닐 수 있다. 주소 중간에 `[현황:○○]`이 먼저 붙거나
   대괄호가 중첩된 물건이 있어서, 위치와 무관하게 찾는다.
2. **토지면 대괄호 안 지목이 곧 세분류다.** 법원 카테고리와 대조했을 때 전답 99%, 임야 97%, 대지 91% 일치.
3. **건물이면 법원 `category` leaf가 1순위.** 집합건물 용도는 주소 문자열로 못 맞힌다
   (건물명만으로 판정하면 아파트 44%, 다세대 9%까지 떨어진다).
4. 그 다음이 대괄호 안 건축물 용도 토큰 → 건물명·주소 키워드.

지식산업센터와 노인복지주택은 법원이 `기타`로만 보내서 건물명으로 알아본다
(`KNOWLEDGE_CENTER_RE` / `SENIOR_HOUSING_RE`). 이름에 "지식산업센터"가 그대로 박힌 물건이
소수라 브랜드명을 넣었고, 후보는 실제 데이터로 걸렀다 — 분류가 이 단계까지 내려오는 물건 중
주거 카테고리가 하나도 없고 국세청 인덱스 교차검증에서도 상업용으로 나오는 이름만 남겼다.
("비즈니스센터"는 11건 중 7건이 오피스텔이라 뺐다.)

### 주의: `category`에 그룹 라벨이 섞여 온다

법원 원본 `category`에는 개별 용도(`아파트`, `다세대`)와 **검색 그룹 라벨**(`상가,오피스텔,근린시설`,
`연립주택,다세대,빌라`, `대지,임야,전답`)이 섞여 있다. 이걸 부분 문자열로 훑으면
`상가,오피스텔,근린시설` 4,323건이 통째로 "오피스텔"이 된다. 그래서 그룹 라벨은 **정확히 일치할 때만**
해석하고, 키워드 매칭 텍스트에는 `category`를 넣지 않는다.

`상가,오피스텔,근린시설`은 셋 중 무엇인지 법원이 공개하지 않는 유일한 진짜 모호 구간이라 두 단계로 푼다.

- 지하·1층이면 근린상가로 본다 (국세청 기준시가 대조: 1층은 99%가 상가)
- 나머지는 `상가·오피스텔 미확정`으로 두고, 국세청 인덱스에서 용도를 찾아 확정한다.
  국세청 상업용건물·오피스텔 기준시가는 호실 단위로 용도(`O`/`S`)를 들고 있다.

확정 근거는 두 가지이고 **순서를 지켜야 한다.**

1. **국세청 상업용건물·오피스텔 기준시가** — 호실 단위라 정확하다
2. **건축물대장 주용도**(`property.building.main_purpose`) — 1이 답을 못 낼 때만 쓰는 폴백

주용도를 뒤에 두는 이유는, 그 값이 "이 물건의 용도"가 아니라 **"이 필지 대표 건물의 용도"**이기
때문이다. 수집기는 한 필지에 여러 동이 있으면 연면적이 가장 큰 동을 고른다. 그래서 주상복합에서
아파트 동이 오피스텔 동보다 크면 오피스텔 물건에도 "공동주택"이 붙는다.
법원이 상가·오피스텔·근린시설이라 한 물건에 대장이 공동주택이라고 하면, 둘이 정면으로 어긋나는
것이므로 단정하지 않고 미확정으로 남긴다.

확정은 두 군데서 일어난다. **서버**가 물건을 내보내기 전에
`resolveAmbiguousCategories`(`lib/normalize.mjs`)로 먼저 확정하고, PNU가 나중에 지오코딩으로
채워진 물건만 **화면**에서 기준시가를 조회할 때 확정된다(`app.js` `refinedCategory`).
서버에서 미리 하는 이유는, 화면 조회만으로는 지도에 뜬 물건이 조회를 끝낸 뒤라야 반영돼서
칩 건수가 처음엔 틀린 값으로 보였다가 나중에 움직이기 때문이다.

조회 대상은 `needsStandardPriceLookup`(`categories.js`)이 정한다. 국세청 인덱스는 상업용건물·
오피스텔만 담고 있어서 구분소유 건물이 아니면 뒤져도 안 나온다 — 실측으로 `상가·오피스텔 미확정`은
54%, 집합건물인 `용도 확인필요`는 40%가 확정되고, 집합건물이 아닌 `용도 확인필요`는 0%라 아예 조회하지 않는다.

확정이 아닌 분류는 `categoryConfident: false`로 표시하고 카드에 "추정 분류" 태그를 붙인다.

## MVP 범위

- 최저입찰가와 공시가격 기준가 비교
- 인근 실거래가 중앙값 비교
- 지도 마커, 리스트, 상세 패널
- 물건 종별(대분류·세분류) · 매각 형태 · 지역 · 할인율 · 위험도 필터
- 점수 기반 우선순위 정렬
- `data/` 폴더 기반 실매물 CSV/JSON 반입
- 공시지가 API 프록시 엔드포인트 준비

## 다음 연동 후보

- 온비드 OpenAPI 물건 수집
- 공공데이터 기반 개별공시지가/PNU 매칭
- 국토교통부 실거래가 데이터 매칭
- 권리분석 체크리스트와 위험 가중치 고도화

## 실데이터 연동

VWorld에서 확인한 공식 API:

- 서비스 목록: [VWorld API 서비스 목록](https://www.vworld.kr/dtna/dtna_apiSvcList_s001.do?searchKeyword=%EA%B0%9C%EB%B3%84%EA%B3%B5%EC%8B%9C%EC%A7%80%EA%B0%80)
- 사용할 API: `개별공시지가속성조회`
- API 번호: `25`
- 요청주소: `https://api.vworld.kr/ned/data/getIndvdLandPriceAttr`
- 필수 파라미터: `pnu`, `key`
- 선택 파라미터: `stdrYear`, `format`, `numOfRows`, `pageNo`, `domain`
- 기준일: `2026-05-26`

참고: `WMS`는 지도 이미지, `WFS`는 도형/피처 조회, `속성조회`는 JSON/XML 속성값 조회입니다. 꽁지맵의 최저입찰가 대비 공시지가 비교에는 `개별공시지가속성조회`의 JSON 응답을 사용합니다.

서버 API:

- `GET /api/properties`: `data/properties.json`, `data/onbid.csv`, `data/court-auction.csv`를 읽어 지도용 물건으로 정규화합니다.
- `GET /api/court-auctions`: 로컬 법원경매 크롤러 API(`/api/v1/auctions`)를 꽁지맵 물건 형식으로 정규화합니다. `.env`의 `COURT_AUCTION_API_URL`로 서버 주소를 바꿀 수 있습니다.
- `GET /api/land-price?pnu=...&year=2025`: VWorld 개별공시지가속성조회 프록시입니다. `.env`의 `VWORLD_API_KEY`가 필요합니다.
- `GET /api/housing-price?pnu=...&kind=apart|indvd&year=2026&address=...`: VWorld 공동주택가격(`getApartHousingPriceAttr`)·개별주택가격(`getIndvdHousingPriceAttr`) 프록시입니다. 같은 `VWORLD_API_KEY`를 씁니다. `kind=apart`는 주소에서 동/호를 파싱해 해당 세대의 공시가격 총액을 찾고(`dong`/`ho`/`area` 파라미터로 직접 지정 가능), `kind=indvd`는 PNU당 1건인 개별주택가격을 반환합니다.
- `GET /api/officetel-price?pnu=...&address=...`: 국세청 상업용건물·오피스텔 기준시가를 로컬 인덱스에서 조회합니다. PNU로 필지를, 주소의 층/호로 세대를 특정해 기준시가 총액(단가 × (전용면적+공유면적))을 반환합니다. API 키가 필요 없습니다.
- `GET /api/geocode?address=...`: VWorld 주소검색으로 주소를 정밀 좌표와 19자리 PNU로 변환합니다. `VWORLD_API_KEY`가 필요합니다.
- `GET /api/seoul-deals?district=강서구&dong=화곡동&type=오피스텔`: 서울시 부동산 실거래가 정보 프록시입니다. `.env`의 `SEOUL_REAL_ESTATE_API_KEY`가 필요합니다.
- `GET /api/onbid-properties`: 온비드 API 응답을 꽁지맵 매물 형식으로 정규화합니다. `.env`의 `ONBID_SERVICE_KEY`가 필요합니다.
- `GET /api/onbid`: 온비드 API 프록시 자리입니다. `.env`의 `ONBID_SERVICE_KEY`가 필요합니다.

대법원경매는 공식 공개 API가 확인되지 않아 현재는 `data/court-auction.csv` 반입 방식으로 처리합니다. 무단 크롤링으로 붙이면 서비스 안정성과 약관 문제가 생길 수 있어 별도 데이터 공급원이나 수동 반입 경로를 먼저 씁니다.

온비드 기본 엔드포인트는 부동산 물건목록 조회서비스(`OnbidRlstListSrvc2`)입니다. 다른 온비드 서비스를 붙일 때만 `ONBID_API_URL`로 override합니다.

키 설정:

```bash
cp .env.example .env
```

그 뒤 `.env`에 필요한 키를 채우고 서버를 재시작합니다.

```env
VWORLD_API_KEY=발급받은_VWorld_API_KEY
VWORLD_API_DOMAIN=http://127.0.0.1:4173
COURT_AUCTION_API_URL=http://127.0.0.1:8000
COURT_AUCTION_ACTIVE=all
COURT_AUCTION_REQUIRE_COORDINATES=1
SEOUL_REAL_ESTATE_API_KEY=서울시_부동산_실거래가_API_KEY
ONBID_SERVICE_KEY=온비드_서비스키
```
