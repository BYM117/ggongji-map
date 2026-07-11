# 꽁지맵 MVP

공시지가와 최저입찰가를 비교해 경공매 물건을 선별하고, 주변 실거래 근거를 함께 보는 초기 MVP입니다.

## 구조

- `index.html`, `app.js`, `styles.css`: 프론트엔드 (외부 API 텍스트는 전부 `escapeHtml`로 이스케이프)
- `dev-server.mjs`: HTTP 서버 + API 라우팅 + 정적 파일 서빙 (숨김 파일과 허용 확장자 밖 파일은 서빙하지 않음)
- `lib/util.mjs`: 숫자/CSV/쿼리 파싱, 동시성, 상한이 있는 캐시 헬퍼
- `lib/geo.mjs`: 좌표 추정 테이블(시/도, 시/군/구, 느슨한 매칭)과 뷰포트 경계 계산 — 좌표 테이블은 이 파일에서만 관리
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
`data/court-auctions.snapshot.json`에 저장된 좌표 보강 완료 물건을 읽어 지도에 표시할 수 있습니다.

Vercel 환경변수:

```env
VWORLD_API_KEY=발급받은_VWorld_API_KEY
SEOUL_REAL_ESTATE_API_KEY=서울시_부동산_실거래가_API_KEY
ONBID_SERVICE_KEY=온비드_서비스키
```

법원경매는 Vercel에서 기본적으로 `data/court-auctions.snapshot.json` 스냅샷을 읽습니다. `ONBID_API_URL`, `COURT_AUCTION_SNAPSHOT_PATH`, `ONBID_DEFAULT_QUERY` 같은 공개 고정값은 코드 기본값을 사용합니다.

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

## MVP 범위

- 최저입찰가와 공시가격 기준가 비교
- 인근 실거래가 중앙값 비교
- 지도 마커, 리스트, 상세 패널
- 물건 유형, 지역, 할인율, 위험도 필터
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
