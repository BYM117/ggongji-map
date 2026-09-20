#!/bin/bash
#
# 세션을 시작할 때 "다른 세션이 지금 무엇을 하고 있나"를 한 번에 보여준다.
#
#   ./scripts/세션점검.sh
#
# 왜 이게 필요한가 — 2026-09-20 에 확인한 것이다.
# 예전 규칙은 `git status` + `git log --oneline -5` 였는데, 세션이 워크트리 안에서
# 돌면 **둘 다 자기 브랜치·자기 폴더만 본다.** 실제로 워크트리에 들어가 그대로
# 실행해 보니 다른 두 세션의 커밋이 한 줄도 안 나왔다. 세 세션이 사흘 동안 서로를
# 모른 채 같은 파일(app.js·index.html·DECISIONS.md)을 고쳤고, 규칙을 다 지켰는데도
# 아무도 그걸 보지 못했다. 볼 수 없는 것을 보라고 시켜 놨던 것이다.
#
# 그래서 여기서는 `--all` 과 `git worktree list` 로 전부 꺼내 본다.
# 브랜치 하나만 보는 명령은 이 파일에 넣지 않는다.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# 워크트리에서 부르면 여기가 자기 폴더다. 공유 .git 은 따로 찾는다(아래 보드).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "❌ git 저장소가 아니다."; exit 1; }

echo "════════ 세션 점검 ════════"
echo

# ── 지금 어디에 서 있나 ────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  WHERE="워크트리"
else
  WHERE="원본 폴더"
fi
echo "▸ 지금: $WHERE · 브랜치 $BRANCH"
echo "  $ROOT"

# 원격을 먼저 당겨온다. 이게 없으면 "배포본이 나보다 앞서 있다"를 못 본다.
# macOS 에는 `timeout` 이 없다(GNU coreutils 다). 있으면 쓰고 없으면 그냥 부른다 —
# 대신 자격증명 프롬프트로 세션이 멈추지 않게 GIT_TERMINAL_PROMPT=0 을 건다.
if command -v timeout >/dev/null 2>&1; then
  FETCH=(timeout 15 git fetch -q origin)
elif command -v gtimeout >/dev/null 2>&1; then
  FETCH=(gtimeout 15 git fetch -q origin)
else
  FETCH=(git fetch -q origin)
fi
if GIT_TERMINAL_PROMPT=0 "${FETCH[@]}" 2>/dev/null; then
  UP="$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo origin/main)"
  COUNTS="$(git rev-list --left-right --count "$UP...HEAD" 2>/dev/null)" || COUNTS=""
  if [ -n "$COUNTS" ]; then
    BEHIND="$(echo "$COUNTS" | cut -f1)"
    AHEAD="$(echo "$COUNTS" | cut -f2)"
    echo "  $UP 대비: 앞선 커밋 ${AHEAD}개 · 뒤진 커밋 ${BEHIND}개"
    [ "$BEHIND" != "0" ] && echo "  ⚠️  배포본에 있는데 나한테 없는 커밋이 ${BEHIND}개다. 먼저 합쳐라."
  fi
else
  echo "  (원격을 못 불러왔다 — 오프라인이거나 느리다. 아래 정보는 마지막으로 받아온 것 기준이다.)"
fi
echo

# ── 저장 안 된 변경 — 모든 워크트리를 본다 ──────────────────────────────
echo "▸ 저장 안 된 변경"
FOUND_DIRTY=0
# `read -r WT _` 로 자르면 안 된다 — 이 저장소 경로에 공백이 있다("꽁지맵 개발").
# 줄 전체를 그대로 받아야 한다.
while IFS= read -r WT; do
  [ -z "$WT" ] && continue
  N="$(git -C "$WT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  TIP="$(git -C "$WT" log --oneline -1 2>/dev/null)"
  MARK="  "
  if [ "$N" != "0" ]; then MARK="⚠️ "; FOUND_DIRTY=1; fi
  printf "  %s%-52s %s개\n" "$MARK" "$(basename "$WT")" "$N"
  printf "     └ %s\n" "$TIP"
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
[ "$FOUND_DIRTY" = "1" ] && echo "  ⚠️  다른 세션이 아직 커밋 안 한 것이 있다. 그 파일은 건드리지 마라."
echo

# ── main 에 안 합쳐진 브랜치 — 오늘 사고의 정체 ─────────────────────────
echo "▸ main 에 아직 안 합쳐진 브랜치"
ORPHAN=0
while read -r B; do
  [ -z "$B" ] && continue
  # backup/* 는 일부러 남겨 둔 것이라 영원히 안 합쳐진다. 매번 뜨면
  # 이 칸 전체를 무시하게 되므로 뺀다.
  case "$B" in main|origin/main|origin/HEAD*|backup/*|origin/backup/*) continue;; esac
  echo "  ⚠️  $B — $(git log --oneline -1 "$B" 2>/dev/null)"
  ORPHAN=1
done < <(git branch --all --no-merged main --format='%(refname:short)' 2>/dev/null)
[ "$ORPHAN" = "0" ] && echo "  없음"
echo

# ── 전체 그래프 — 갈라진 게 있으면 여기서 눈에 보인다 ───────────────────
echo "▸ 최근 커밋 (모든 브랜치)"
git log --all --graph --oneline --decorate -12 | sed 's/^/  /'
echo

# ── 세션 보드 — git 바깥이라 브랜치와 무관하게 즉시 공유된다 ────────────
"$(dirname "$0")/세션보드.sh" 2>/dev/null

echo "══════════════════════════"
