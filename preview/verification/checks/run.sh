#!/usr/bin/env bash
# 面板交互回归检查：用渲染脚手架挂 client.js 里真实的面板，逐个执行 ./*.check.js，统计 PASS / FAIL 与控制台报错。
#
# 运行：bash preview/verification/checks/run.sh [React 18 UMD 目录的 URL]
#   不给 URL：用脚手架自带的迷你 React 运行时。
#   给了（例如 http://127.0.0.1:8000/umd/，目录下要有 react.development.js 与 react-dom.development.js，React 18）：
#   改用真 React 并包 StrictMode。React 由运行者自己提供（本仓库不带依赖）。
# 需要 node、curl 与 playwright-cli 在 PATH 上。playwright-cli 会把日志写进当前目录，所以脚本先 cd 到一个临时目录，结束时删掉。
# 每个检查文件第一行可写 `// query: <脚手架 URL 参数>`（例如 w=960&delay=400）。退出码：有 FAIL 或控制台报错为 1。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PORT="${WSM_CHECK_PORT:-47431}"
REACT="${1:-}"
WORK="$(mktemp -d)"
cd "$WORK" || exit 1

node "$HERE/serve.mjs" "$REPO" "$PORT" > "$WORK/serve.log" 2>&1 &
for i in $(seq 1 40); do
  curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/client.js" && break
  sleep 0.25
done

P="playwright-cli -s=wsm-checks"
$P open about:blank > /dev/null 2>&1
$P resize 1080 1000 > /dev/null 2>&1
pass=0
fail=0
for f in "$HERE"/*.check.js; do
  name="$(basename "$f" .check.js)"
  q="$(sed -n 's#^// query: ##p' "$f" | head -1)"
  [ -n "$REACT" ] && q="$q&react=$REACT&strict=1"
  $P goto "http://127.0.0.1:$PORT/preview/verification/render-harness.html?$q" > /dev/null 2>&1
  title=""
  for i in $(seq 1 60); do
    title="$($P eval "document.title" 2>/dev/null | grep -o '"[^"]*"' | head -1)"
    case "$title" in *READY*|*ERROR*) break ;; esac
    sleep 0.25
  done
  echo "== $name ${REACT:+(React)}"
  case "$title" in *READY*) ;; *) echo "  FAIL harness not ready: $title"; fail=$((fail + 1)); continue ;; esac
  result="$($P eval "$(cat "$f")" 2>&1)"
  # 只看 Result 段（playwright-cli 还会回显被执行的源码，里面也有 'PASS ' / 'FAIL ' 字样）
  lines="$(printf '%s\n' "$result" | sed -n '/^### Result/,/^### /p' | grep -o '\(PASS\|FAIL\) [^\\"]*')"
  if [ -z "$lines" ]; then
    echo "  FAIL check did not finish:"
    printf '%s\n' "$result" | sed -n '1,8p' | sed 's/^/    /'
    fail=$((fail + 1))
  else
    printf '%s\n' "$lines" | sed 's/^/  /'
    pass=$((pass + $(printf '%s\n' "$lines" | grep -c '^PASS')))
    fail=$((fail + $(printf '%s\n' "$lines" | grep -c '^FAIL')))
  fi
  errors="$($P console 2>&1 | grep -o 'Errors: [0-9]*' | head -1 | grep -o '[0-9]*')"
  if [ -n "$errors" ] && [ "$errors" != "0" ]; then
    echo "  FAIL console errors: $errors"
    $P console error 2>&1 | grep -v '^###' | sed -n '1,6p' | sed 's/^/    /'
    fail=$((fail + 1))
  fi
done

$P close > /dev/null 2>&1
curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/__quit"
cd / && rm -rf "$WORK"
echo "checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
