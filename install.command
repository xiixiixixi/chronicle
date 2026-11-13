#!/bin/bash
# install.command — Chronicle macOS 双击安装器
#
# 用法：在 Finder 里双击本文件（macOS 会用 Terminal 打开它）。
# 也可以：bash install.command
#
# 功能（交互菜单）：
#   1) 安装 / 升级 Chronicle（npm install（如需要）+ npm run setup）
#   2) 接入 AI 工具（先展示 dry-run 计划，确认后 node mcp-install.mjs --target all --yes）
#   3) 查看运行状态（node daemon.mjs --status）
#   4) 退出
#
# 设计约束：只依赖本仓库与系统自带命令；不联网下载除 npm install 之外的任何东西；
# 不修改用户的隐私配置；不删除任何数据。

set -euo pipefail

# 双击时当前目录是 $HOME，必须先切到脚本所在目录（允许通过软链调用）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

TIMELINE_URL="http://127.0.0.1:3777/"
MCP_ENTRY="$SCRIPT_DIR/mcp-entry.mjs"

say() { printf '%s\n' "$*"; }
hr() { say "============================================================"; }
press_enter() {
  printf '\n按回车键继续…'
  read -r _ || true
  printf '\n'
}

hr
say " Chronicle 安装器（macOS 双击版）"
say " 目标目录：$SCRIPT_DIR"
hr
say ""

# ---------- ① 环境检查（node / npm / swiftc） ----------
missing=0
if command -v node >/dev/null 2>&1; then
  say "✓ Node.js：$(node --version)"
else
  say "✗ 未找到 Node.js（Chronicle 需要 Node.js 18 或更高版本）"
  say "  请安装：https://nodejs.org/zh-cn  或用 Homebrew：brew install node"
  missing=1
fi
if command -v npm >/dev/null 2>&1; then
  say "✓ npm：$(npm --version)"
else
  say "✗ 未找到 npm（通常随 Node.js 一起安装）"
  missing=1
fi
if command -v swiftc >/dev/null 2>&1; then
  say "✓ swiftc：$(swiftc --version 2>&1 | head -n 1)"
else
  say "✗ 未找到 swiftc（编译采集守护需要 Xcode 命令行工具）"
  say "  请在终端运行：xcode-select --install"
  say "  安装完成后重新双击本安装器。"
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  say ""
  say "缺少必要依赖，安装已退出（本脚本没有修改任何文件）。"
  say ""
  exit 1
fi

say "✓ 环境检查通过"

# ---------- ② 交互菜单 ----------
while true; do
  say ""
  say "请选择操作（输入数字后回车）："
  say "  1) 安装 / 升级 Chronicle"
  say "  2) 接入 AI 工具（Claude Code / Claude Desktop / Cursor / Codex / VS Code）"
  say "  3) 查看运行状态"
  say "  4) 退出"
  printf '> '
  read -r choice || choice="4"

  case "$choice" in
    1)
      say ""
      say "【安装 / 升级】"
      if [ ! -d node_modules ]; then
        say "首次安装：正在安装 Node 依赖（npm install）…"
        if ! npm install --no-audit --no-fund; then
          say "✗ npm install 失败。请检查网络或 Node.js 安装后重试。"
          press_enter
          continue
        fi
      else
        say "依赖已存在，跳过 npm install。"
      fi
      say ""
      say "正在执行安装向导（npm run setup）：编译采集守护、创建数据目录、安装权限主体…"
      if ! npm run setup; then
        say ""
        say "✗ 安装向导失败（常见原因：没有 Xcode 命令行工具、swiftc 不可用）。"
        say "  可先运行 xcode-select --install 后再试。"
        press_enter
        continue
      fi
      say ""
      say "✓ 安装 / 升级完成。"
      say "  下一步：运行 npm run daemon 启动记录器，然后打开 $TIMELINE_URL"
      press_enter
      ;;
    2)
      say ""
      say "【接入 AI 工具】"
      say "下面先展示计划（dry-run，不会写入任何配置）："
      say ""
      node mcp-install.mjs --target all || true
      say ""
      printf '确认按上面的计划写入上述配置文件？[y/N] '
      read -r confirm || confirm="n"
      case "$confirm" in
        y|Y|yes|YES)
          say ""
          if node mcp-install.mjs --target all --yes; then
            say ""
            say "✓ 已写入。请重启对应的 AI 工具（或新开一个会话）后使用。"
            say "  之后可运行 node mcp-install.mjs --list 检查配置状态。"
          else
            say ""
            say "✗ 部分目标写入失败（原配置已备份，未破坏）。详情见上方输出。"
          fi
          ;;
        *)
          say "已取消，未修改任何配置文件。"
          ;;
      esac
      press_enter
      ;;
    3)
      say ""
      say "【运行状态】"
      if ! node daemon.mjs --status; then
        say "记录器未在运行。先运行 npm run daemon；若已安装开机自启（launchd 未移除），稍等几秒会自动起来。"
      fi
      press_enter
      ;;
    4|q|Q)
      break
      ;;
    *)
      say "无效输入，请输入 1、2、3 或 4。"
      ;;
  esac
done

# ---------- ③ 收尾提示 ----------
say ""
hr
say " Chronicle 使用提示"
hr
say " 时间线地址： $TIMELINE_URL"
say "   （需要记录器在运行：npm run daemon；安装时默认已注册开机自启）"
say ""
say " AI 工具接入："
say "   - 菜单栏应用：「AI 工具接入…」（会复制 mcp-install.mjs --print 的配置）"
say "   - 命令行：   node mcp-install.mjs --target all --yes"
say ""
say " 查看状态：   node daemon.mjs --status"
say " 停止记录器： node daemon.mjs --stop"
say " 接入状态：   node mcp-install.mjs --list"
say " 安装文档：   INSTALL.md"
hr
say ""
printf '按回车键关闭本窗口…'
read -r _ || true
printf '\n'
