#!/bin/bash
#
# 세션끼리 "지금 무엇을 하는 중인지"를 실시간으로 주고받는 칠판.
#
#   ./scripts/세션보드.sh                          최근 글 보기
#   ./scripts/세션보드.sh "상세 패널 손보는 중 · app.js"   한 줄 적기
#   ./scripts/세션보드.sh --끝                      이 세션 마감 표시
#
# 왜 파일을 git 밖에 두는가 —
# `docs/DECISIONS.md` 를 공유 채널로 쓰고 있었는데, 그 파일은 **브랜치 안에** 있다.
# 세션 A 가 거기 적어도 A 의 브랜치에만 있고, B 는 합치기 전까지 못 본다.
# 즉 "실시간 공유"가 원리적으로 불가능한 자리였다. 게다가 다 같이 파일 끝에 쓰니
# 합칠 때마다 충돌했다(2026-09-20 병합 두 번, 두 번 다 충돌).
#
# 그래서 칠판은 공유 .git 디렉터리 안에 둔다. 워크트리를 몇 개 만들든
# `git rev-parse --git-common-dir` 은 전부 같은 곳을 가리키므로 파일이 하나다.
# git 이 추적하지 않으니 브랜치와 무관하고, 커밋되지 않고, 충돌하지 않는다.
#
# 확정된 결정은 여기 적지 않는다 — 그건 `docs/DECISIONS.md` 다.
# 여기는 "지금 누가 어디를 만지는 중"만 적는다. 며칠 지나면 의미가 없는 글이다.

set -uo pipefail

COMMON="$(git rev-parse --git-common-dir 2>/dev/null)" || { echo "❌ git 저장소가 아니다."; exit 1; }
case "$COMMON" in
  /*) ;;
  *) COMMON="$(cd "$COMMON" && pwd)" ;;
esac
BOARD="$COMMON/세션보드.md"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
NOW="$(date '+%m-%d %H:%M')"

case "${1:-}" in
  "")
    echo "▸ 세션 보드 (git 밖 · 모든 세션이 같은 파일을 본다)"
    if [ ! -s "$BOARD" ]; then
      echo "  비어 있음.  적으려면:  ./scripts/세션보드.sh \"무엇을 하는 중인지\""
    else
      # 오래된 글은 지금 상황이 아니다. 최근 것만 보여준다.
      tail -12 "$BOARD" | sed 's/^/  /'
      echo "  ── 전체: $BOARD"
    fi
    ;;
  --끝|--end)
    printf '%s · %-34s · 🏁 세션 끝\n' "$NOW" "$BRANCH" >> "$BOARD"
    echo "🏁 보드에 마감을 적었다."
    ;;
  *)
    printf '%s · %-34s · %s\n' "$NOW" "$BRANCH" "$*" >> "$BOARD"
    echo "✍️  보드에 적었다: $*"
    ;;
esac
