"""仅用 Python 标准库，把 source/app.ico 内已有的 RGBA PNG 缩放导出；不访问用户数据。"""
import binascii
import math
from pathlib import Path
import struct
import zlib


def paeth(a, b, c):
    p = a + b - c
    differences = [abs(p - a), abs(p - b), abs(p - c)]
    return [a, b, c][differences.index(min(differences))]


def decode_png(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n', '最大图标不是 PNG'
    compressed = bytearray()
    offset = 8
    while offset < len(data):
        size, tag = struct.unpack_from('>I4s', data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        assert binascii.crc32(tag + chunk) & 0xffffffff == struct.unpack_from('>I', data, offset + 8 + size)[0]
        if tag == b'IHDR':
            width, height, depth, color, comp, filtering, interlace = struct.unpack('>IIBBBBB', chunk)
            assert (depth, color, comp, filtering, interlace) == (8, 6, 0, 0, 0), '只支持现有图标的 8 位 RGBA PNG'
        elif tag == b'IDAT':
            compressed.extend(chunk)
        elif tag == b'IEND':
            break
        offset += size + 12
    raw = zlib.decompress(compressed)
    stride = width * 4
    assert len(raw) == height * (stride + 1)
    rows = []
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        method = raw[start]
        assert method <= 4
        row = bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            left = row[x - 4] if x >= 4 else 0
            up = previous[x]
            corner = previous[x - 4] if x >= 4 else 0
            predictor = [0, left, up, (left + up) // 2, paeth(left, up, corner)][method]
            row[x] = (row[x] + predictor) & 255
        rows.append(row)
        previous = row
    return width, height, rows


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', binascii.crc32(tag + data) & 0xffffffff)


def resize_png(width, height, rows, size):
    # 先合成到 Theme.cs 的浅薄荷底，主屏幕图标不留透明区域。
    opaque = []
    for row in rows:
        result = []
        for x in range(width):
            r, g, b, a = row[x * 4:x * 4 + 4]
            result.append(tuple((c * a + bg * (255 - a)) / 255 for c, bg in zip((r, g, b), (238, 243, 241))))
        opaque.append(result)
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        fy = min(height - 1, max(0, (y + .5) * height / size - .5))
        y0, y1 = math.floor(fy), min(height - 1, math.floor(fy) + 1)
        dy = fy - y0
        for x in range(size):
            fx = min(width - 1, max(0, (x + .5) * width / size - .5))
            x0, x1 = math.floor(fx), min(width - 1, math.floor(fx) + 1)
            dx = fx - x0
            for channel in range(3):
                top = opaque[y0][x0][channel] * (1 - dx) + opaque[y0][x1][channel] * dx
                bottom = opaque[y1][x0][channel] * (1 - dx) + opaque[y1][x1][channel] * dx
                pixels.append(round(top * (1 - dy) + bottom * dy))
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    ico = (root / 'source/app.ico').read_bytes()
    count = struct.unpack_from('<H', ico, 4)[0]
    entries = [struct.unpack_from('<BBBBHHII', ico, 6 + i * 16) for i in range(count)]
    largest = max(entries, key=lambda entry: (entry[0] or 256) * (entry[1] or 256))
    length, offset = largest[-2:]
    width, height, rows = decode_png(ico[offset:offset + length])
    for size in (180, 192, 512):
        target = root / 'web/icons' / ('icon-%d.png' % size)
        target.write_bytes(resize_png(width, height, rows, size))
        print('已导出 %d×%d PNG' % (size, size))
