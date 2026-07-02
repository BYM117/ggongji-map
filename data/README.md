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

대법원경매는 공식 공개 API가 없으므로 우선 CSV/JSON 반입으로 처리합니다. 온비드는 API 문서와 인증키가 준비되면 `.env`에 `ONBID_API_URL`, `ONBID_SERVICE_KEY`를 넣어 서버 프록시에서 연결합니다.

온비드 OpenAPI 연동:

- `.env`에 `ONBID_API_URL`, `ONBID_SERVICE_KEY`를 넣으면 `/api/properties`가 온비드 응답도 함께 읽습니다.
- 별도 점검은 `/api/onbid-properties`에서 합니다.
- 온비드 응답에 좌표가 없으면 지도에 올릴 수 없어 `droppedCount`로 제외 개수가 표시됩니다.
- 좌표 없는 물건은 다음 단계에서 주소 지오코딩을 붙여 보강합니다.
