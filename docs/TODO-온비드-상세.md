# 공매(온비드) 물건을 누르면 법원경매 상세를 부른다

**상태:** 미착수 · 다른 세션에서 처리 예정
**발견:** 2026-09-12 (모바일 시트 작업 중 콘솔에서)
**영향 범위:** `app.js` 한 곳 (`loadPropertyDetail`)

---

## 한 줄로

물건을 누르면 **그게 경매든 공매든 무조건 법원경매 상세 API를 부른다.**
공매 물건 번호를 법원 쪽에 넣으니 당연히 못 알아듣고 400으로 돌려보낸다.

---

## 증상

공매 물건을 클릭할 때마다 실패 요청이 하나씩 나간다.

```
GET /api/court-auction-detail?id=2026-14163-001  →  400 Bad Request
```

`2026-14163-001`은 온비드 관리번호다. 법원경매 사건번호(`2024타경124807` 꼴)가 아니다.

**화면이 깨지지는 않는다.** 응답이 실패하면 `state.detailData = null`이 되어
상세 패널은 요약 수치(최저입찰가·공시가·할인율 등)만 그리고, 사진·법원문서·사건정보
섹션은 그냥 안 나온다. 사용자에게 에러 메시지는 안 뜬다.

그래서 **조용히 낭비되고 있는 상태**다. 급하지는 않지만 남겨둘 이유도 없다.

---

## 원인

`app.js`의 `loadPropertyDetail()`이 물건 출처를 보지 않는다.

```js
// app.js  (openPropertyDetail → loadPropertyDetail)
function openPropertyDetail(id) {
  ...
  loadPropertyDetail(id);          // ← 출처와 무관하게 항상 호출
}

async function loadPropertyDetail(id) {
  const response = await fetch(`/api/court-auction-detail?id=${id}`);  // ← 법원 전용
  ...
}
```

출처를 판별하는 함수는 이미 있다.

```js
function sourceKind(item) {
  const source = String(item?.source || "");
  if (source.includes("온비드")) return "onbid";
  if (source.includes("법원")) return "court";
  return "court";
}
```

공매 물건의 `source`는 `"온비드 OpenAPI"`다. 즉 `sourceKind(item) === "onbid"`로
걸러낼 수 있다.

**참고:** 공매용 상세 엔드포인트는 없다. `dev-server.mjs`에 있는 온비드 경로는
`/api/onbid-properties`와 `/api/onbid` 둘뿐이고, 목록용이다.

---

## 고칠 방향 (둘 중 택 1)

### A. 부르지 않는다 — 작고 확실함

`loadPropertyDetail`에서 공매면 바로 빠져나온다. 상세 패널은 지금도 요약만으로
잘 그려지므로 화면은 달라지지 않고, 실패 요청과 로딩 스켈레톤 깜빡임만 사라진다.

주의할 점: `state.detailLoadingId`를 반드시 비워야 한다. 안 그러면
"상세 정보를 불러오는 중입니다…"가 영영 남는다.

### B. 공매 상세를 만든다 — 크다

온비드 OpenAPI에서 상세를 받아오는 경로를 새로 판다. 사진·문서가 있는지부터
확인이 필요하다. **하기로 정하기 전에 사용자에게 물어볼 것.**

권장은 **A**. B는 온비드가 실제로 뭘 더 주는지 확인한 뒤에 판단한다.

---

## 작업 전 주의 — 로컬에서 법원 물건이 0건으로 보일 수 있다

`.claude/launch.json`이 서버를 `COURT_AUCTION_USE_SNAPSHOT=1`로 띄운다.
이 값이 켜지면 `.env`의 `COURT_AUCTION_API_URL`을 **무시하고** 스냅샷 파일을 읽는데,
그 파일(`data/court-auctions.snapshot.json.gz`)은 커밋 `e32fe0b`에서 이미 지워졌다.

결과: 법원 물건 0건, 공매만 보인다. `.env` 설정이 잘못된 게 아니다.

확인 방법 — `diagnostics.endpoint`가 비어 있으면 스냅샷 모드다.

```bash
curl -s "http://127.0.0.1:4173/api/court-auctions?swLat=37.52&swLng=126.90&neLat=37.61&neLng=127.05" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('diagnostics'))"
```

경매·공매를 나란히 놓고 테스트하려면 스냅샷 모드를 끄고 띄워야 한다.
**이건 이 작업과 별개 건이다. `launch.json`을 고칠지는 사용자에게 따로 확인할 것.**

---

## 검증할 것

- 공매 물건 클릭 → `/api/court-auction-detail` 요청이 **나가지 않는다**
- 공매 상세 패널에 요약 수치가 그대로 나온다
- "상세 정보를 불러오는 중입니다…"가 남지 않는다
- 경매 물건 클릭 → 사진·법원문서·사건정보가 **전과 똑같이** 나온다 (회귀 확인)
