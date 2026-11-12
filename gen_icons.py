"""
生成扩展图标 PNG（纯标准库，无 PIL 依赖）。
设计：蓝色圆角方块 + 白色准星环 + 中心点 + 四向刻度。
输出 16/32/48/128 四个尺寸。
"""
import zlib
import struct
import math
import os

OUT = os.path.dirname(os.path.abspath(__file__)) + os.sep + 'browser-agent' + os.sep + 'icons'


def inside_round_rect(x, y, S, rad):
    if x < 0 or y < 0 or x >= S or y >= S:
        return False
    if x < rad and y < rad:
        return (x - rad) ** 2 + (y - rad) ** 2 <= rad * rad
    if x > S - rad and y < rad:
        return (x - (S - rad)) ** 2 + (y - rad) ** 2 <= rad * rad
    if x < rad and y > S - rad:
        return (x - rad) ** 2 + (y - (S - rad)) ** 2 <= rad * rad
    if x > S - rad and y > S - rad:
        return (x - (S - rad)) ** 2 + (y - (S - rad)) ** 2 <= rad * rad
    return True


def sample(fx, fy, S):
    """返回该点的 RGBA 或 None（透明）。"""
    if not inside_round_rect(fx, fy, S, S * 0.22):
        return None
    cx = cy = S / 2.0
    ring_r = S * 0.265
    ring_w = max(1.0, S * 0.078)
    dot_r = S * 0.058
    tick_in = S * 0.355
    tick_out = S * 0.465
    tick_w = max(1.0, S * 0.078)

    d = math.hypot(fx - cx, fy - cy)
    white = False
    if abs(d - ring_r) <= ring_w / 2.0:
        white = True
    if d <= dot_r:
        white = True
    if abs(fx - cx) <= tick_w / 2.0 and tick_in <= abs(fy - cy) <= tick_out:
        white = True
    if abs(fy - cy) <= tick_w / 2.0 and tick_in <= abs(fx - cx) <= tick_out:
        white = True

    if white:
        return (255, 255, 255, 255)
    return (37, 99, 235, 255)  # #2563EB


def gen(size, ss=3):
    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter type 0
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    c = sample(px, py, size)
                    if c:
                        r += c[0]
                        g += c[1]
                        b += c[2]
                        a += c[3]
            n = ss * ss
            if a == 0:
                row += bytes([0, 0, 0, 0])
            else:
                cover = a / (255 * n)
                row += bytes([
                    int(r / n),
                    int(g / n),
                    int(b / n),
                    int(255 * cover),
                ])
        rows.append(bytes(row))
    return rows


def write_png(path, w, h, rows):
    raw = b''.join(rows)
    comp = zlib.compress(raw, 9)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', comp)
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 32, 48, 128):
        rows = gen(s, ss=3 if s <= 48 else 2)
        p = os.path.join(OUT, 'icon%d.png' % s)
        write_png(p, s, s, rows)
        print('wrote %s (%d bytes)' % (p, os.path.getsize(p)))
