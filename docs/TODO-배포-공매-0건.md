# 배포된 화면에 공매가 0건으로 뜬다

**상태:** 원인 좁혀짐 · 미착수 · 다른 세션에서 처리 예정
**발견:** 2026-09-13 (공매 상세 배포 직후 확인 중에)
**영향 범위:** `lib/vworld.mjs` 또는 Vercel 환경 설정. 코드가 아니라 환경 쪽일 가능성이 크다.

---

## 한 줄로

로컬에서는 같은 화면에 공매가 25건 뜨는데 **배포된 화면에서는 0건**이다.
공매 물건은 좌표가 없어 주소로 구해야 하는데, **VWorld가 Vercel에서만 502를 준다.**

이것 때문에 온비드 상세 기능이 배포는 됐지만 화면에서는 아직 볼 수 없다.

---

## 증거

프로덕션 `viewport-properties` 진단 응답:

```
regionSource:     "province_fallback"     ← 시군구를 못 구해 시도 단위로 떨어졌다
regionError:      "502 Bad Gateway"       ← VWorld 역지오코딩 실패
scannedRows:      5032
uniqueCount:      558
geocodeAttempts:  8
geocodeSuccesses: 0                       ← 좌표를 하나도 못 구했다
returnedCount:    0
```

558건을 추려놓고 좌표가 없어 전부 버린다.

## 확인한 것 / 아닌 것으로 밝혀진 것

같은 키로 개발 PC에서 VWorld를 직접 부르면 **정상(HTTP 200, status OK)**이다.

도메인 제한도 아니다. `domain` 파라미터를 네 가지로 바꿔가며 불러도 전부 `OK`였다.

```
(도메인 없음)                            200 OK
http://127.0.0.1:4173                   200 OK
https://ggongji-map.vercel.app          200 OK
https://ggongji-map-abc123.vercel.app   200 OK
```

`vworldDomain()`(`lib/vworld.mjs:463`)도 이미 배포마다 바뀌는 `VERCEL_URL`보다
고정 주소인 `VERCEL_PROJECT_PRODUCTION_URL`을 먼저 쓰도록 돼 있다.

**즉 키도 도메인도 코드도 아니다. Vercel에서 VWorld로 나가는 경로 자체가 막혀 있다.**

## 다음 세션이 먼저 볼 것

1. **Vercel 환경변수에 `VWORLD_API_DOMAIN`이 들어가 있는지.** `.env`를 그대로 복사해
   `http://127.0.0.1:4173`이 박혀 있으면 그 값이 최우선으로 쓰인다(`lib/vworld.mjs:464`).
   이게 가장 가능성이 높고, 확인도 제일 싸다.
2. 그게 아니면 VWorld가 Vercel 대역 IP를 막는 경우다. 이쪽이면 코드로는 못 풀고
   좌표를 미리 채워 두는 방식으로 돌아가야 한다.

`lib/onbid.mjs` 상단 주석이 이 상황을 이미 예상하고 있다 —
"좌표 조회가 통째로 막히는 일이 실제로 있다(배포 환경의 VWorld 장애)".
그때를 위한 fallback이 도는 중인데, 지금은 fallback조차 좌표를 못 구해 0건이 된다.

---

## 이 문제가 아닌 것

로딩이 느려진 건 이 문제와 별개다. `docs/TODO-물건-로딩속도.md`에 따로 적었다.
