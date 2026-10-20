#!/bin/bash
# 面具 · macOS 启动器
# 用法：双击本文件（首次可能需要在「系统设置 → 隐私与安全性」里允许运行），
#      或在终端执行  chmod +x start.command && ./start.command
cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  面具 · AI 脱敏系统"
echo "=========================================="

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js。"
  echo "       请安装 Node.js 22.5 或更高版本：https://nodejs.org"
  echo "       或使用 Homebrew：brew install node"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=5)?"1":"0")')
if [ "$NODE_OK" != "1" ]; then
  echo "[错误] 需要 Node.js 22.5 或更高版本，当前是 $(node -v)。"
  echo "       本应用用 Node 内置的 node:sqlite，22.4 及以下没有这个模块。"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖，请稍候…"
  npm install --omit=dev --no-audit --no-fund || { echo "[错误] 依赖安装失败，请检查网络。"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; }
fi

if [ ! -d web/dist ]; then
  echo "[错误] 缺少前端构建产物 web/dist，请使用官方分发包。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo
echo "  启动地址：http://127.0.0.1:9909"
echo "  默认账号：aiadmin / admin123（登录后请立刻在「用户管理」里改掉）"
echo "  停止服务：在本窗口按 Control + C"
echo "  说明：首次启动会装配本地外部引擎（Python 引擎；Windows 专属的 JDK/Go 引擎在 macOS 上不装），"
echo "        耗时长且需要联网；装配失败不影响内置规则引擎。"
echo
( sleep 2; open "http://127.0.0.1:9909" >/dev/null 2>&1 ) &

node --no-warnings scripts/start.mjs

echo
echo "服务已停止。"
read -n 1 -s -r -p "按任意键关闭窗口…"
