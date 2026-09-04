#!/bin/bash
#
# 새 작업용 폴더를 만든다.   사용법:  ./scripts/새작업.sh 디자인
#
# 세션마다 자기 폴더에서 일하게 하려는 것이다. 같은 폴더를 여럿이 쓰면
# 나중에 연 세션이 먼저 연 세션의 파일을 조용히 덮어쓰고, 아무도 그걸 모른다.
#
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "❌ 작업 이름을 적어줘."
  echo "   예:  ./scripts/새작업.sh 디자인"
  exit 1
fi

# 워크트리 안에서 실행해도 항상 '원본 폴더'를 찾아낸다.
COMMON="$(git rev-parse --git-common-dir)"
case "$COMMON" in /*) ;; *) COMMON="$PWD/$COMMON" ;; esac
MAIN_DIR="$(cd "$(dirname "$COMMON")" && pwd)"

DEST="$(dirname "$MAIN_DIR")/꽁지맵-$NAME"
BRANCH="work/$NAME"

if [ -e "$DEST" ]; then
  echo "❌ 이미 있어:  $DEST"
  echo "   그 폴더에서 이어서 작업하거나, 다른 이름을 써줘."
  exit 1
fi

if git -C "$MAIN_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "❌ '$BRANCH' 작업이 이미 열려 있어."
  echo "   목록 보기:  ./scripts/작업목록.sh"
  exit 1
fi

# 원본 폴더에 저장 안 된 변경이 있으면 새 폴더로 따라가지 않는다. 미리 알려준다.
if [ -n "$(git -C "$MAIN_DIR" status --porcelain)" ]; then
  echo "⚠️  원본 폴더에 저장 안 된 변경이 있어. 새 폴더에는 안 따라가."
  git -C "$MAIN_DIR" status --short | sed 's/^/     /'
  echo ""
fi

git -C "$MAIN_DIR" worktree add -b "$BRANCH" "$DEST" main

# .env 는 git 이 관리하지 않아서 새 폴더에 안 생긴다. 원본을 가리키게 이어준다.
# 복사하지 않는 이유: 키를 한 곳에서만 고치기 위해서다.
if [ -f "$MAIN_DIR/.env" ]; then
  ln -s "$MAIN_DIR/.env" "$DEST/.env"
  echo "🔑 .env 연결됨 (원본을 그대로 씀)"
fi

echo ""
echo "✅ 만들었어:  $DEST"
echo ""
echo "   1. Claude Code 에서 위 폴더를 열고 작업해"
echo "   2. 다 끝나면 그 폴더에서:  ./scripts/작업끝.sh"
