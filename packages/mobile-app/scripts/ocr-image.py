#!/usr/bin/env python3
"""截图文本提取(本地排障用):Vision OCR 输出「位置 + 文本」。

为什么需要:`Read` 工具把图片交给模型时,部分模型不支持图像输入,
拿不到截图内容就无法按截图改 UI。这里用 macOS Vision 在本地做 OCR,
输出归一化坐标换算后的像素位置,足够还原界面文字与大致布局。

依赖:仓库内 venv(packages/mobile-app/.venv-ocr):
    python3 -m venv .venv-ocr
    .venv-ocr/bin/pip install pyobjc-framework-Vision pyobjc-framework-Quartz

用法:
    .venv-ocr/bin/python scripts/ocr-image.py <image.png> [more.png ...]
"""
import sys

import Quartz
import Vision
from Foundation import NSURL


def ocr(path: str) -> None:
    url = NSURL.fileURLWithPath_(path)
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    if source is None:
        print(f"== {path}: CANNOT LOAD")
        return
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
    width = Quartz.CGImageGetWidth(image)
    height = Quartz.CGImageGetHeight(image)
    print(f"== {path} ({width}x{height}) ==")

    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setRecognitionLanguages_(["zh-Hans", "en-US"])
    request.setUsesLanguageCorrection_(True)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        print(f"OCR FAILED: {error}")
        return

    lines = []
    for observation in request.results() or []:
        candidate = observation.topCandidates_(1)[0]
        box = observation.boundingBox()
        # Vision 坐标原点在左下;换算成「左上原点」的像素坐标,直观对应截图。
        x = int(box.origin.x * width)
        y = int((1 - box.origin.y - box.size.height) * height)
        w = int(box.size.width * width)
        h = int(box.size.height * height)
        lines.append((box.origin.y, box.origin.x, x, y, w, h, candidate.string()))
    # 先上后下,同一行(归一化 y 差 < 0.008)再从左到右。
    lines.sort(key=lambda item: (-round(item[0] / 0.008), item[1]))
    for _, _, x, y, w, h, text in lines:
        print(f"  {x:>5},{y:>5} {w:>4}x{h:<4} {text}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for argument in sys.argv[1:]:
        ocr(argument)
