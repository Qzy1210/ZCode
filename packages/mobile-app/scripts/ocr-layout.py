#!/usr/bin/env python3
"""截图结构提取(本地排障用):矩形(卡片/按钮)位置 + 主色采样。

配合 scripts/ocr-image.py 使用:OCR 给文字与坐标,本脚本给卡片/按钮边界与配色,
两者合起来可以还原设计稿布局(模型不支持图像输入时的主要手段)。

依赖:同 ocr-image.py(packages/mobile-app/.venv-ocr)。

用法:
    .venv-ocr/bin/python scripts/ocr-layout.py <image.png>
"""
import sys

import Quartz
import Vision
from Foundation import NSURL


def analyze(path: str) -> None:
    url = NSURL.fileURLWithPath_(path)
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    if source is None:
        print(f"== {path}: CANNOT LOAD")
        return
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
    width = Quartz.CGImageGetWidth(image)
    height = Quartz.CGImageGetHeight(image)
    print(f"== {path} ({width}x{height}) ==")

    # 矩形检测:卡片/按钮/输入框轮廓。
    rectangles = Vision.VNDetectRectanglesRequest.alloc().init()
    rectangles.setMaximumObservations_(120)
    rectangles.setMinimumConfidence_(0.25)
    rectangles.setMinimumSize_(0.01)
    rectangles.setMinimumAspectRatio_(0.02)
    rectangles.setQuadratureTolerance_(35.0)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    ok, error = handler.performRequests_error_([rectangles], None)
    if ok:
        found = []
        for observation in rectangles.results() or []:
            box = observation.boundingBox()
            x = int(box.origin.x * width)
            y = int((1 - box.origin.y - box.size.height) * height)
            w = int(box.size.width * width)
            h = int(box.size.height * height)
            if w >= 8 and h >= 8:
                found.append((y, x, w, h, observation.confidence()))
        found.sort()
        print(f"-- 矩形 {len(found)} 个(按 y 排序,置信度>=0.25)")
        for y, x, w, h, confidence in found:
            print(f"   x={x:>4} y={y:>4} {w:>4}x{h:<4} conf={confidence:.2f}")
    else:
        print(f"矩形检测失败: {error}")

    # 主色采样:四角/中心/常见控件位置。
    provider = Quartz.CGImageGetDataProvider(image)
    data = Quartz.CGDataProviderCopyData(provider)
    raw = bytes(data) if data is not None else b""
    if raw:
        bytes_per_row = Quartz.CGImageGetBytesPerRow(image)
        bits_per_pixel = Quartz.CGImageGetBitsPerPixel(image)
        print(f"-- 像素格式 bpp={bits_per_pixel} rowBytes={bytes_per_row}")

        def sample(x: int, y: int) -> str:
            offset = y * bytes_per_row + x * (bits_per_pixel // 8)
            pixel = raw[offset : offset + 4]
            if len(pixel) < 4:
                return "?"
            # CGImage 默认 BGRA 排列。
            b, g, r, a = pixel[0], pixel[1], pixel[2], pixel[3]
            return f"#{r:02x}{g:02x}{b:02x}(a{a})"

        points = [
            ("左上角", 2, 2),
            ("顶部中间", width // 2, 2),
            ("右上角", width - 3, 2),
            ("中心", width // 2, height // 2),
            ("左下角", 2, height - 3),
            ("底部中间", width // 2, height - 3),
            ("右下角", width - 3, height - 3),
            ("1/4 高", width // 2, height // 4),
            ("3/4 高", width // 2, (height * 3) // 4),
        ]
        for label, x, y in points:
            print(f"   {label} ({x},{y}) = {sample(x, y)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for argument in sys.argv[1:]:
        analyze(argument)
