#!/usr/bin/env python3
"""在任务列表的 uiautomator dump 里找第一个**任务行**并输出其中心坐标。

为什么要单独成文件:这段判定原先内联在 shell 的 python3 -c "..." 里,中文与引号在
shell 双引号内需要逐字符转义,一旦漏转义整段检测就会静默失败(表现为"未找到任务行",
随后脚本点空、退出应用)。抽成脚本后 shell 侧只负责取 dump。

排除项:项目卡片(标签形如"<名称>,收起任务")——点它只会折叠/展开列表,不是打开会话。
输出:`<x> <y>`(未找到则不输出任何内容,退出码 0)。
用法:uiautomator dump 的 XML 从 stdin 传入。
"""
import re
import sys

STATUS_LABELS = ("运行中", "等待中", "已完成", "出错", "空闲")


def main() -> None:
    count_only = "--count" in sys.argv
    list_mode = "--list" in sys.argv
    xml = sys.stdin.read()
    candidates: list[tuple[int, int, int, int]] = []
    for match in re.finditer(r"<node[^>]*/?>", xml):
        node = match.group(0)
        if 'clickable="true"' not in node:
            continue
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if not bounds:
            continue
        desc = re.search(r'content-desc="([^"]*)"', node)
        label = desc.group(1) if desc else ""
        x1, y1, x2, y2 = map(int, bounds.groups())
        # 列表区域、足够宽(排除顶部按钮与"＋"窄按钮)。
        if y1 < 300 or (x2 - x1) < 600:
            continue
        if "任务" in label and ("收起" in label or "展开" in label):
            continue
        # 优先状态为"已完成"的任务:场景 18/25 要看完成轮的折叠摘要,运行中的会话
        # 可能只有一个进行中的轮,没有摘要可验(会误报失败)。
        score = 0
        if "已完成" in label:
            score += 3
        elif any(status in label for status in STATUS_LABELS):
            score += 2
        if ", " in label:
            score += 1
        candidates.append((-score, y1, (x1 + x2) // 2, (y1 + y2) // 2, label))
    if list_mode:
        for _, y1, _cx, _cy, label in sorted(candidates):
            print(f"{y1}\t{label}")
        return
    if count_only:
        print(len(candidates))
        return
    if not candidates:
        return
    _, _, center_x, center_y, _label = sorted(candidates)[0]
    print(center_x, center_y)


if __name__ == "__main__":
    main()
