#!/bin/bash
#
# 지금 열려 있는 작업 폴더를 보여준다.   사용법:  ./scripts/작업목록.sh
#
set -euo pipefail

COMMON="$(git rev-parse --git-common-dir)"
case "$COMMON" in /*) ;; *) COMMON="$PWD/$COMMON" ;; esac
MAIN_DIR="$(cd "$(dirname "$COMMON")" && pwd)"

echo "📂 열려 있는 작업 폴더"
echo ""

git -C "$MAIN_DIR" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r DIR; do
  BR="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  DIRTY="$(git -C "$DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

  if [ "$DIR" = "$MAIN_DIR" ]; then
    LABEL="원본"
  else
    LABEL="작업중"
  fi

  if [ "$DIRTY" = "0" ]; then
    STATE="✅ 저장 완료"
  else
    STATE="⚠️  저장 안 된 파일 ${DIRTY}개"
  fi

  echo "  [$LABEL] $BR"
  echo "         $DIR"
  echo "         $STATE"
  echo ""
done
