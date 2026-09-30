#!/bin/bash
# 真机场景验收:按 spec 的验收场景驱动 App 并逐条判定。
#
# 用法:
#   bash packages/mobile-app/scripts/verify-device-scenarios.sh [--quick|--send]
#
#   --quick  只跑只读场景(列表/会话/折叠/工具卡片/返回),不产生任何副作用
#   --send   额外跑"发送消息"场景(会在新建的草稿会话里发一条短消息,产生一个任务)
#
# 前提:手机 USB 已连接并**解锁**,ZCode App 可启动;桌面端已运行。
#
# 说明:uiautomator 的 bounds 是窗口相对坐标,本机实测需加状态栏偏移;
# 脚本先按原坐标点,未见界面变化则自动加偏移重试,避免硬编码机型差异。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
PKG="dev.zcode.mobile"
MODE="${1:---quick}"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); say "FAIL  $1${2:+ :: $2}"; }

dump_texts() {
  adb shell uiautomator dump /sdcard/scenario.xml >/dev/null 2>&1
  # text 与 content-desc 都收:工具条图标按钮(＋/🛡/◯/📦/🧠)只带 accessibilityLabel,
  # 不读 content-desc 就看不到它们,场景判定会误判成"控件缺失"。
  adb shell cat /sdcard/scenario.xml 2>/dev/null |
    tr '>' '\n' | grep -oE '(text|content-desc)="[^"]*"' | grep -v '="=""' |
    sed 's/^[a-z-]*=//; s/"//g' | grep -v '^$'
}

has_text() { dump_texts | grep -qxF "$1"; }
has_substring() { dump_texts | grep -qF "$1"; }

# 点击文本对应控件;bounds 为窗口相对坐标,必要时加状态栏偏移重试。
tap_text() {
  local target="$1" nth="${2:-0}" before after x y
  before="$(dump_texts | md5)"
  x="$(adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re,sys
target, nth = sys.argv[1], int(sys.argv[2])
xml = sys.stdin.read()
hits = [m for m in re.finditer(r'<node[^>]*text=\"([^\"]*)\"[^>]*>', xml) if m.group(1) == target]
if len(hits) <= nth: raise SystemExit
b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', hits[nth].group(0))
x1,y1,x2,y2 = map(int, b.groups()); print((x1+x2)//2, (y1+y2)//2)
" "$target" "$nth" 2>/dev/null)"
  if [ -z "$x" ]; then say "  (未找到可点文本: $target)"; return 1; fi
  # 只有落在顶部状态栏区域(y 很小)时才需要加偏移;其余位置直接点,
  # 否则"未见界面变化就重试"会把第二次点击落到别的控件上(曾因此点开了别的会话)。
  local px py y
  px="$(echo "$x" | awk '{print $1}')"
  y="$(echo "$x" | awk '{print $2}')"
  py="$y"
  [ "$y" -lt 200 ] && py=$((y + 95))
  adb shell input tap "$px" "$py" >/dev/null 2>&1
  sleep 3
  after="$(dump_texts | md5)"
  [ "$before" != "$after" ] && return 0
  return 1
}

# 点击"文本或 content-desc 包含子串"的控件(工具条图标只有 accessibilityLabel)。
tap_text_contains() {
  local target="$1" coord x y py
  adb shell uiautomator dump /sdcard/scenario.xml >/dev/null 2>&1
  coord="$(adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re, sys
target = sys.argv[1]
xml = sys.stdin.read()
for m in re.finditer(r'<node[^>]*/?>', xml):
    node = m.group(0)
    values = re.findall(r'(?:text|content-desc)=\"([^\"]*)\"', node)
    if not any(target in value for value in values):
        continue
    b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
    if b:
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1+x2)//2, (y1+y2)//2)
        break
" "$target" 2>/dev/null)"
  if [ -z "$coord" ]; then say "  (未找到可点控件: $target)"; return 1; fi
  x="$(echo "$coord" | awk '{print $1}')"
  y="$(echo "$coord" | awk '{print $2}')"
  py="$y"
  [ "$y" -lt 200 ] && py=$((y + 95))
  adb shell input tap "$x" "$py" >/dev/null 2>&1
  sleep 2
  return 0
}

# 上滑(内容下移)以翻到更早的历史轮:运行中的会话默认停在最新轮。
scroll_up() {
  local times="${1:-2}" i
  for i in $(seq 1 "$times"); do
    adb shell input swipe 630 900 630 1900 300 >/dev/null 2>&1
    sleep 1
  done
}

wait_for() {
  local target="$1" seconds="${2:-10}" i
  for i in $(seq 1 "$seconds"); do
    has_substring "$target" && return 0
    sleep 1
  done
  return 1
}

# 打开第一个任务行:不依赖标题(任务名会随会话变化),按可点区域位置识别。
tap_first_task() {
  local before after coord
  before="$(dump_texts | md5)"
  coord="$(adb shell uiautomator dump /sdcard/scenario.xml >/dev/null 2>&1; adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re, sys
xml = sys.stdin.read()
for m in re.finditer(r'<node[^>]*/?>', xml):
    node = m.group(0)
    if 'clickable=\"true\"' not in node:
        continue
    b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
    if not b:
        continue
    x1, y1, x2, y2 = map(int, b.groups())
    # 任务行:足够宽且在列表区域(排除顶部按钮/新建任务窄按钮)
    if y1 > 400 and (x2 - x1) > 600:
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
" 2>/dev/null)"
  if [ -z "$coord" ]; then say "  (未找到任务行)"; return 1; fi
  local px py y
  px="$(echo "$coord" | awk '{print $1}')"
  y="$(echo "$coord" | awk '{print $2}')"
  py="$y"
  [ "$y" -lt 200 ] && py=$((y + 95))
  adb shell input tap "$px" "$py" >/dev/null 2>&1
  sleep 3
  after="$(dump_texts | md5)"
  [ "$before" != "$after" ] && return 0
  return 1
}

diagnostics() {
  say "  --- 当前界面文本(前 12 条) ---"
  dump_texts | head -12 | sed 's/^/  | /'
}

say "==> 启动 App"
adb shell am start -S -n "$PKG/.MainActivity" >/dev/null 2>&1
sleep 10

# ── 场景 17/21/30:任务列表 ──
# P6 起「＋ 新建任务」收进项目行尾的小圆钮(文本就是"＋"),不再有整块按钮。
if has_text "＋"; then ok "场景 21:项目行尾出现「＋」新建入口"; else bad "场景 21:未见新建任务入口"; fi
if dump_texts | grep -q "已连接"; then ok "连接状态可见(免扫码/扫码)"; else bad "未显示已连接"; fi
if dump_texts | grep -q "加载更早的消息"; then bad "场景 17:列表仍出现「加载更早的消息」按钮"; else ok "场景 17:无底部「加载更早」按钮"; fi
if dump_texts | grep -qE "同步中|同步失败"; then bad "列表卡在同步中/同步失败"; else ok "列表未卡在同步态"; fi

# ── 场景 30:项目行点击展开/收起 ──
# P6-3 起项目是卡片:折叠箭头在「N 个任务 ▾/▸」文本里(不再是独立节点)。
# 判定:点卡片头 → 含「个任务 ▾」的文本变「个任务 ▸」且首个任务行移出。
card_arrow_bounds() {
  local arrow="$1"
  adb shell uiautomator dump /sdcard/scenario.xml >/dev/null 2>&1
  adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re, sys
arrow = sys.argv[1]
xml = sys.stdin.read()
for m in re.finditer(r'<node[^>]*/?>', xml):
    node = m.group(0)
    if f'个任务 {arrow}' not in node: continue
    b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
    if b:
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1+x2)//2, (y1+y2)//2 + (95 if (y1+y2)//2 < 200 else 0))
        break
" "$arrow" 2>/dev/null
}
first_task_below_card() {
  adb shell uiautomator dump /sdcard/scenario.xml >/dev/null 2>&1
  adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re, sys
xml = sys.stdin.read()
header_y = None
for m in re.finditer(r'<node[^>]*/?>', xml):
    node = m.group(0)
    if header_y is None:
        if '个任务 ' in node and ('▾' in node or '▸' in node):
            b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
            if b:
                header_y = int(b.groups()[3])
        continue
    t = re.search(r'text=\"([^\"]*)\"', node)
    b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
    if t and b and t.group(1) and '个任务' not in t.group(1):
        # 卡片头下方的第一个文本(剩余时间里/标题)视为首个任务行线索。
        if int(b.groups()[1]) >= header_y and '更新于' not in t.group(1):
            print(t.group(1)); break
" 2>/dev/null
}
expanded_arrow="$(card_arrow_bounds "▾")"
if [ -n "$expanded_arrow" ]; then
  before_text="$(first_task_below_card)"
  adb shell input tap "$(echo "$expanded_arrow" | awk '{print $1}')" "$(echo "$expanded_arrow" | awk '{print $2}')" >/dev/null 2>&1
  sleep 2
  collapsed_arrow="$(card_arrow_bounds "▸")"
  after_text="$(first_task_below_card)"
  if [ -n "$collapsed_arrow" ] && [ "$before_text" != "$after_text" ]; then
    ok "场景 30:点项目卡片收起任务(箭头 ▾→▸,任务行移出)"
  else
    bad "场景 30:收起后任务行未消失" "before=$before_text after=$after_text arrow=${collapsed_arrow:-无}"
  fi
  adb shell input tap "$(echo "$expanded_arrow" | awk '{print $1}')" "$(echo "$expanded_arrow" | awk '{print $2}')" >/dev/null 2>&1
  sleep 2
  restored_arrow="$(card_arrow_bounds "▾")"
  restored_text="$(first_task_below_card)"
  if [ -n "$restored_arrow" ] && [ "$restored_text" == "$before_text" ]; then
    ok "场景 30:再点展开恢复任务行"
  else
    bad "场景 30:展开后任务行未恢复" "restored=$restored_text before=$before_text"
  fi
else
  bad "场景 30:未找到可点项目卡片(个任务 ▾)"
fi

# ── 打开任务行(现在任务行在项目行下方;先确保列表处于展开态)──
# tap_first_task 按可点区域位置识别任务行;折叠态下先展开再找。
if ! tap_first_task; then
  # 列表可能全部收起:点一次每个 ▸ 展开(只点一次,避免把已展开的又收起)。
  for arrow_y in $(adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re, sys
xml = sys.stdin.read()
for m in re.finditer(r'<node[^>]*/?>', xml):
    node = m.group(0)
    if 'text=\"▸\"' not in node: continue
    b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
    if b:
        x1, y1, x2, y2 = map(int, b.groups())
        y = (y1+y2)//2 + (95 if (y1+y2)//2 < 200 else 0)
        print((x1+x2)//2, y)
" 2>/dev/null); do
    adb shell input tap "$(echo "$arrow_y" | awk '{print $1}')" "$(echo "$arrow_y" | awk '{print $2}')" >/dev/null 2>&1
    sleep 1
  done
  sleep 1
fi
if ! has_substring "模型:"; then
  if tap_first_task; then say "  (已打开任务会话)"; else bad "打开任务会话失败"; diagnostics; fi
fi
if wait_for "模型:" 10; then ok "场景 22:底部工具条出现模型入口(accessibilityLabel)"; else bad "场景 22:未见底部工具条"; diagnostics; fi
# 五个工具条按钮(截图对照):＋/🛡/◯/📦/🧠 的 accessibilityLabel。
toolbar_labels="权限模式: 上下文用量 模型: 思考级别:"
missing_labels=""
for label in $toolbar_labels; do
  dump_texts | grep -qF "$label" || missing_labels="$missing_labels $label"
done
if [ -z "$missing_labels" ]; then
  ok "场景 22:工具条含 权限/用量/模型/思考级别 四入口"
else
  bad "场景 22:工具条缺少入口" "$missing_labels"
fi
# 逐个点开面板再关掉:确认「思考级别」「上下文用量」两个新面板可打开。
for label in "思考级别:" "上下文用量"; do
  if tap_text_contains "$label"; then
    if wait_for "选择在下次发送时生效" 5; then ok "场景 22:面板可打开($label)"; else bad "场景 22:面板未打开($label)"; fi
    adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1
    sleep 1
  else
    bad "场景 22:点不到 $label"
  fi
done
# 运行中的会话视口停在最新轮,先上滑翻出已完成的轮再判定折叠与展开入口。
if ! dump_texts | grep -qE '^(已工作|已处理|已停止|已失败|工作中|查看过程)'; then
  scroll_up 3
fi
if dump_texts | grep -qE '^(已工作|已处理|已停止|已失败|工作中)'; then
  ok "场景 18:完成轮折叠为一行摘要"
else
  bad "场景 18:未见折叠摘要行"
fi
if dump_texts | grep -q "查看过程"; then
  ok "过程块提供「查看过程」入口"
  tap_text "查看过程" >/dev/null 2>&1 || true
  if dump_texts | grep -qE "^(展开|收起)$"; then
    ok "场景 25:展开后出现工具卡片(含展开入口)"
  else
    bad "场景 25:展开后未见工具卡片"
  fi
  tap_text "查看过程" >/dev/null 2>&1 || true
else
  bad "未见「查看过程」入口"; diagnostics
fi

# ── 场景 34:新建/进入会话不再停在「正在加载会话…」,且顶部有安全区 ──
# 进入会话后立刻抓一次:若长时间停留"正在加载会话…"即竞态未修复。
if dump_texts | grep -q "正在加载会话"; then
  sleep 3
  if dump_texts | grep -q "正在加载会话"; then
    bad "场景 34:会话停留在「正在加载会话…」(订阅竞态未修复)"
  else
    ok "场景 34:加载态短暂出现后脱离"
  fi
else
  ok "场景 34:未出现「正在加载会话…」或已瞬时脱离"
fi
# 运行中的会话应可见「中断」按钮(空闲会话不显示,不强判)。
if dump_texts | grep -qE "^(中断|正在停|中断中)$"; then
  ok "场景 34:运行中会话出现「中断」按钮"
fi

# ── 返回列表(常驻订阅) ──
# 用硬件返回键(与用户操作一致,且不依赖顶部坐标推断);失败再退回点按钮。
# 返回后用硬件键;等待列表出现(若误退出应用会重新启动并自动连接,最长约 15s)。
adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1
sleep 2
# 返回列表后出现项目行尾的「＋」即列表健在;wait_for 的 md5 技法对滚动列表
# 不可靠(列表持续刷新,md5 一直在变),直接轮询文本。
back_ok=0
for i in $(seq 1 15); do
  if has_text "＋" && dump_texts | grep -q "已连接"; then back_ok=1; break; fi
  sleep 1
done
if [ "$back_ok" = "1" ]; then
  ok "场景 19:返回列表正常(未卡同步)"
else
  tap_text "‹ 返回" >/dev/null 2>&1 || true
  sleep 2
  if has_text "＋"; then ok "场景 19:返回列表正常(点「‹ 返回」兜底)"; else bad "场景 19:返回后列表异常"; diagnostics; fi
fi

# ── 新建任务(可选:发送场景) ──
if [ "$MODE" = "--send" ]; then
  if tap_text "＋ 新建任务" >/dev/null 2>&1 && wait_for "新任务" 8; then
    ok "场景 21:新建任务进入草稿会话"
    if dump_texts | grep -q "新建任务失败"; then
      bad "createSession 被拒(clientId/协议链路问题)"
    else
      ok "场景 20:命令链路可用(createSession 走同一 clientId 信封,未被 clientMismatch 拒绝)"
    fi
    # 先聚焦输入框:input text 只会送到当前获得焦点的控件。
    tap_text "输入消息…" >/dev/null 2>&1 || true
    # 注意:部分机型(实测华为)的输入法不接受 `adb shell input text`,文本不会落进输入框;
    # 因此"命令是否被接受"的主证据是上一步的 createSession(同一命令客户端/信封/clientId),
    # 消息发送这一步留给人工确认观感。
    adb shell input text "hi" >/dev/null 2>&1
    if ! dump_texts | grep -qE '^(hi|发送)$'; then
      say "  (跳过发送:该机型输入法不接受 adb 注入文本)"
    elif tap_text "发送" >/dev/null 2>&1; then
      sleep 4
      if dump_texts | grep -q "hi"; then
        ok "命令被接受(用户消息已出现;clientId 回归通过)"
      else
        bad "发送后未见用户消息(可能被 clientMismatch 拒绝)"
      fi
      if dump_texts | grep -qE "被拒绝|失败"; then bad "出现命令拒绝提示"; fi
    else
      bad "未找到发送按钮"
    fi
  else
    bad "新建任务未进入会话屏"; diagnostics
  fi
fi

say ""
say "结果:$PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ]
