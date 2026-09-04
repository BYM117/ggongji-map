#!/bin/bash
#
# 작업을 원본에 합치고 이 폴더를 정리한다.   사용법:  ./scripts/작업끝.sh
# 반드시 '새작업.sh' 로 만든 폴더 안에서 실행한다.
#
set -euo pipefail

COMMON="$(git rev-parse --git-common-dir)"
case "$COMMON" in /*) ;; *) COMMON="$PWD/$COMMON" ;; esac
MAIN_DIR="$(cd "$(dirname "$COMMON")" && pwd)"
HERE="$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$HERE" = "$MAIN_DIR" ]; then
  echo "❌ 여기는 원본 폴더야. 합칠 게 없어."
  echo "   작업 폴더(꽁지맵-이름) 안에서 실행해줘."
  exit 1
fi

# 저장 안 한 게 있으면 여기서 멈춘다. 정리하면서 날아가면 되돌릴 방법이 없다.
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 저장(커밋) 안 된 변경이 있어. 이걸 먼저 저장해줘."
  git status --short | sed 's/^/     /'
  echo ""
  echo "   Claude 에게 '커밋해줘' 라고 하면 돼."
  exit 1
fi

if [ -n "$(git -C "$MAIN_DIR" status --porcelain)" ]; then
  echo "❌ 원본 폴더에 저장 안 된 변경이 있어. 합치면 섞여버려."
  git -C "$MAIN_DIR" status --short | sed 's/^/     /'
  echo ""
  echo "   원본 폴더의 세션에서 먼저 커밋해줘."
  exit 1
fi

echo "🔀 '$BRANCH' 를 main 에 합치는 중…"

# 충돌이 나면 원본을 어중간한 상태로 두지 않는다. 되돌리고 사람에게 넘긴다.
if ! git -C "$MAIN_DIR" merge --no-ff "$BRANCH" -m "$BRANCH 작업을 합쳤다"; then
  git -C "$MAIN_DIR" merge --abort || true
  echo ""
  echo "⚠️  같은 곳을 다른 작업도 고쳐서 자동으로 못 합쳤어."
  echo "   아무것도 망가지지 않았고, 원본은 원래대로야."
  echo "   Claude 에게 '$BRANCH 합치다가 충돌났어' 라고 알려주면 정리해줄게."
  exit 1
fi

cd "$MAIN_DIR"
git worktree remove "$HERE"
git branch -d "$BRANCH"

echo ""
echo "✅ 합쳤고 작업 폴더도 정리했어."
echo "   이 창의 폴더는 사라졌으니, 원본 폴더에서 이어서 하면 돼:"
echo "   $MAIN_DIR"
