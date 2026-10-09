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

# 抓取 UI 树:确认 dump 成功再返回。模拟器镜像上 uiautomator 偶发 NPE(进程崩),
# 此时旧 XML 会留在原处——不重试就会读到过期界面,产生假失败。
dump_ui() {
  local attempt=0
  while [ "$attempt" -lt 4 ]; do
    if adb shell uiautomator dump /sdcard/scenario.xml 2>/dev/null | grep -q "dumped to"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

dump_text_only() {
  # 只看 text= 节点(不含 content-desc):面板标题是 text,工具条入口是 accessibilityLabel,
  # 两者混在一起会让"面板已打开"误判(会话正文里也可能出现"已用/上限/剩余")。
  dump_ui || true
  adb shell cat /sdcard/scenario.xml 2>/dev/null |
    tr '>' '\n' | grep -oE 'text="[^"]*"' | grep -v 'text=""' | sed 's/text=//g; s/"//g'
}

dump_texts() {
  dump_ui || true
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
  # 成功判据用"会话屏出现"而不是"3 秒内界面变化":模拟器(冷启动/大会话)渲染可能更慢,
  # md5 比对会在会话已经在渲染的路上就误判失败,后续检查随即落到列表上。
  wait_for "模型:" 12 && return 0
  after="$(dump_texts | md5)"
  [ "$before" != "$after" ] && return 0
  return 1
}

# 点击"文本或 content-desc 包含子串"的控件(工具条图标只有 accessibilityLabel)。
tap_text_contains() {
  local target="$1" coord x y py
  dump_ui || true
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
  local times="${1:-2}" i width height cx top bottom
  width="$(adb shell wm size 2>/dev/null | sed -n 's/.*: \([0-9]*\)x\([0-9]*\)/\1/p')"
  height="$(adb shell wm size 2>/dev/null | sed -n 's/.*: \([0-9]*\)x\([0-9]*\)/\2/p')"
  [ -n "$width" ] || width=1080
  [ -n "$height" ] || height=2400
  cx=$((width / 2))
  top=$((height * 38 / 100))
  bottom=$((height * 78 / 100))
  for i in $(seq 1 "$times"); do
    adb shell input swipe "$cx" "$top" "$cx" "$bottom" 300 >/dev/null 2>&1
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
  coord="$(dump_ui || true
    adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 "$HERE/scripts/device-find-task-row.py")"
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
# 项目卡片的折叠箭头在「N 个任务 ▾/▸」文本里(不再是独立节点);坐标按窗口相对值取,
# 落在顶部状态栏区域时补状态栏偏移。
card_arrow_bounds() {
  local arrow="$1"
  dump_ui || true
  adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 -c "
import re, sys
arrow = sys.argv[1]
xml = sys.stdin.read()
for m in re.finditer(r'<node[^>]*/?>', xml):
    node = m.group(0)
    if f'个任务 {arrow}' not in node: continue
    # 跳过 0 个任务的项目(折叠它不会有任何任务行消失,判定会假失败)。
    if '0 个任务' in node: continue
    b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', node)
    if b:
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1+x2)//2, (y1+y2)//2 + (95 if (y1+y2)//2 < 200 else 0))
        break
" "$arrow" 2>/dev/null
}
# 判定用"可见任务行数量":折叠该卡片后其任务行应从无障碍树消失。
# (之前比"卡片下方第一行文本",在首个项目没有任务时会比到下一张卡片的标题,永远不变。)
dump_task_rows() {
  dump_ui || true
  adb shell cat /sdcard/scenario.xml 2>/dev/null | python3 "$HERE/scripts/device-find-task-row.py" --list
}
# 折叠前记下"该卡片下第一个任务行"的标题(卡片头 y 之下、最近的一条),
# 折叠后它必须从无障碍树里消失——比"可见行数"可靠:折叠腾出的空间会让
# 其它卡片的任务滚进视口,总数可能不变。
task_title_below() {
  local header_y="$1"
  dump_task_rows | awk -F'\t' -v hy="$header_y" '$1 > hy {print $2; exit}'
}
expanded_arrow="$(card_arrow_bounds "▾")"
if [ -n "$expanded_arrow" ]; then
  header_y="$(echo "$expanded_arrow" | awk '{print $2}')"
  # 只取标题部分:任务行标签是「标题, 相对时间, 状态」,相对时间会随时间变化,
  # 用全串比对会在任务更新后假失败(踩过一次)。
  watched_title="$(task_title_below "$header_y" | sed 's/, .*$//')"
  adb shell input tap "$(echo "$expanded_arrow" | awk '{print $1}')" "$(echo "$expanded_arrow" | awk '{print $2}')" >/dev/null 2>&1
  sleep 2
  collapsed_arrow="$(card_arrow_bounds "▸")"
  if [ -n "$collapsed_arrow" ] && [ -n "$watched_title" ] && ! dump_task_rows | grep -qF "$watched_title"; then
    ok "场景 30:点项目卡片收起任务(箭头 ▾→▸,任务行[${watched_title%% *}]移出)"
  else
    bad "场景 30:收起后该卡片任务行仍在" "watched=${watched_title:-无} arrow=${collapsed_arrow:-无}"
  fi
  adb shell input tap "$(echo "$expanded_arrow" | awk '{print $1}')" "$(echo "$expanded_arrow" | awk '{print $2}')" >/dev/null 2>&1
  sleep 2
  restored_arrow="$(card_arrow_bounds "▾")"
  if [ -n "$restored_arrow" ] && [ -n "$watched_title" ] && dump_task_rows | grep -qF "$watched_title"; then
    ok "场景 30:再点展开恢复任务行"
  else
    bad "场景 30:展开后该卡片任务行未恢复" "watched=${watched_title:-无}"
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
# 判定用各面板独有的文案:思考级别面板有档位行;用量面板有「已用/上限/剩余」或空数据提示
# —— 用量面板没有「选择在下次发送时生效」脚注(只读事实)。
panel_open_signature() {
  case "$1" in
    "思考级别:") dump_text_only | grep -qxF "思考级别" ;;
    *) dump_text_only | grep -qxF "上下文用量" ;;
  esac
}
wait_for_panel_open() {
  local label="$1" seconds="${2:-5}" i
  for i in $(seq 1 "$seconds"); do
    panel_open_signature "$label" && return 0
    sleep 1
  done
  return 1
}
# 会话屏守卫:面板开关/返回键可能把屏幕带回列表,后续会话检查前先确保会话打开。
ensure_session_open() {
  if has_substring "模型:"; then return 0; fi
  if tap_first_task; then
    wait_for "模型:" 10
    return 0
  fi
  return 1
}
for label in "思考级别:" "上下文用量"; do
  if tap_text_contains "$label"; then
    if wait_for_panel_open "$label" 5; then
      ok "场景 22:面板可打开($label)"
    else
      bad "场景 22:面板未打开($label)"
    fi
    adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1
    sleep 1
  else
    bad "场景 22:点不到 $label"
  fi
done
ensure_session_open || true
# 运行中的会话视口停在最新轮,先上滑翻出已完成的轮再判定折叠与展开入口。
# 逐次上滑并即时判定:长会话里完成轮可能在多屏之外,固定滚 3 次会漏(出现假失败)。
scroll_tries=0
while [ "$scroll_tries" -lt 6 ] && ! dump_texts | grep -qE '^(已工作|已处理|已停止|已失败|工作中|查看过程)'; do
  scroll_tries=$((scroll_tries + 1))
  scroll_up 1
done
if dump_texts | grep -qE '^(已工作|已处理|已停止|已失败|工作中)'; then
  ok "场景 18:完成轮折叠为一行摘要"
else
  bad "场景 18:未见折叠摘要行"
fi
if dump_texts | grep -q "查看过程"; then
  ok "过程块提供「查看过程」入口"
  tap_text "查看过程" >/dev/null 2>&1 || true
  # 工具卡片可能渲染在可视区之外:最多补 3 次小幅上滑再判定(模拟器屏幕更矮;
  # 会话内容越长,卡片越可能落在折叠区之外——单次滚动不足以稳定命中)。
  nudge=0
  while [ "$nudge" -lt 3 ] && ! dump_texts | grep -qE "^(展开|收起)$"; do
    nudge=$((nudge + 1))
    adb shell input swipe $(( $(adb shell wm size | sed -n 's/.*: \([0-9]*\)x.*/\1/p') / 2 )) \
      $(( $(adb shell wm size | sed -n 's/.*x\([0-9]*\)$/\1/p') * 70 / 100 )) \
      $(( $(adb shell wm size | sed -n 's/.*x\([0-9]*\)$/\1/p') * 40 / 100 )) 300 >/dev/null 2>&1
    sleep 1
  done
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

# ── 场景 38:进入会话默认停在最新内容(离底才显示「跳到最新」按钮)──
# 判定:刚进入时若停在底部,悬浮按钮不应出现在无障碍树里;
# 若仍停在中间(修前就是这样),按钮会出现 → 明确判失败并给出证据。
# 入口位置必须在"刚进入"时判定:此前的场景(翻历史)可能已经上滑,直接读当前状态会误判。
adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1
sleep 2
if tap_first_task; then
  sleep 2  # 等首帧与贴底收敛(收敛窗口约 0.6s)
  if dump_texts | grep -qF "跳到最新消息"; then
    bad "场景 38:进入会话停在中间(出现了「跳到最新」按钮)"
  else
    ok "场景 38:进入会话默认在最新内容"
  fi
else
  bad "场景 38:无法重新进入会话(返回后未见列表/会话)"
fi
# 手动上滑后按钮应出现(证明按钮不是死的),再点它回到最新。
scroll_up 2
if dump_texts | grep -qF "跳到最新消息"; then
  ok "场景 38:上滑离底后出现「跳到最新」按钮"
  if tap_text_contains "跳到最新消息"; then
    sleep 1
    if dump_texts | grep -qF "跳到最新消息"; then
      bad "场景 38:点了「跳到最新」仍不在底部"
    else
      ok "场景 38:点「跳到最新」回到最新内容"
    fi
  else
    bad "场景 38:点不到「跳到最新」按钮"
  fi
else
  bad "场景 38:上滑后未见「跳到最新」按钮"
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
