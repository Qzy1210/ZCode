#!/usr/bin/env python3
"""从截图里解出配对二维码链接(本地排障用)。

用途:桌面端「移动端远程控制」弹窗只显示二维码图片、没有复制链接入口,而模型看不到图像。
这里用 opencv 的 QRCodeDetector 直接解码,拿到的 URL 再注入模拟器/真机完成配对。

依赖(仓库内 venv):packages/mobile-app/.venv-ocr
    .venv-ocr/bin/pip install opencv-python-headless

用法:
    .venv-ocr/bin/python scripts/decode-qr.py <screenshot.png>
"""
import sys

import cv2


def decode(path: str) -> None:
    image = cv2.imread(path)
    if image is None:
        print(f"无法读取图片: {path}")
        raise SystemExit(1)
    detector = cv2.QRCodeDetector()
    text, points, _ = detector.detectAndDecode(image)
    if not text:
        # 整屏里的小二维码常常解不出来:按中心区域裁一圈再试。
        height, width = image.shape[:2]
        for ratio in (0.5, 0.35, 0.25):
            crop = image[
                int(height * (0.5 - ratio / 2)) : int(height * (0.5 + ratio / 2)),
                int(width * (0.5 - ratio / 2)) : int(width * (0.5 + ratio / 2)),
            ]
            text, _, _ = detector.detectAndDecode(crop)
            if text:
                break
    if not text:
        print("NO_QR_FOUND")
        raise SystemExit(2)
    print(text)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    decode(sys.argv[1])
