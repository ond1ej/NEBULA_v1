"""Device-pairing QR encoder: ISO/IEC 18004 structure, known answers, a pure-Python read-back, the SVG, and a
real-decoder round trip through Apple's CoreImage (skipped where /usr/bin/swift is unavailable)."""

from __future__ import annotations

import json
import random
import re
import shutil
import string
import struct
import subprocess
import time
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

import pytest
from nebula_host import qr

PAIRING_URL = (
    "nebula://pair?v=1&u=https%3A%2F%2Fnebula-host.example-tailnets.ts.net&p=pr_0123456789abcdef"
    "&c=Zx8_q-3LmN0pQrStUvWxYz&f=0123456789abcdef"
)
# No "\" or "~": a decoder that guesses Shift_JIS for byte mode would map them to yen / overline.
ALPHABET = string.ascii_letters + string.digits + "-._:/?&=%+#@!$,;*()"

# ISO/IEC 18004 table 1: total codewords and remainder bits per version (spot checks).
TOTAL_CODEWORDS = {1: 26, 2: 44, 5: 134, 7: 196, 10: 346, 14: 581, 15: 655, 25: 1588, 40: 3706}
REMAINDER_BITS = {1: 0, 2: 7, 5: 7, 7: 0, 10: 0, 14: 3, 15: 3, 25: 4, 40: 0}
# Annex E: alignment pattern centre coordinates.
ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
    9: [6, 26, 46], 10: [6, 28, 50], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
    25: [6, 32, 58, 84, 110], 32: [6, 34, 60, 86, 112, 138], 36: [6, 24, 50, 76, 102, 128, 154],
    40: [6, 30, 58, 86, 114, 142, 170],
}
# Table 7: byte-mode capacity (L, M, Q, H).
BYTE_CAPACITY = {
    1: (17, 14, 11, 7), 2: (32, 26, 20, 14), 5: (106, 84, 60, 44), 7: (154, 122, 86, 64),
    10: (271, 213, 151, 119), 40: (2953, 2331, 1663, 1273),
}
# Annex C: masked format information, per ECC level, masks 0..7.
FORMAT_TABLE = {
    "L": (0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976),
    "M": (0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0),
    "Q": (0x355F, 0x3068, 0x3F31, 0x3A06, 0x24B4, 0x2183, 0x2EDA, 0x2BED),
    "H": (0x1689, 0x13BE, 0x1CE7, 0x19D0, 0x0762, 0x0255, 0x0D0C, 0x083B),
}
# Annex D: version information.
VERSION_INFO = {7: 0x07C94, 8: 0x085BC, 21: 0x15683, 40: 0x28C69}
ECC_FROM_BITS = {0b01: "L", 0b00: "M", 0b11: "Q", 0b10: "H"}

# Mask conditions written from the standard's (i = row, j = column) form, independently of the module.
MASKS = (
    lambda i, j: (i + j) % 2 == 0,
    lambda i, j: i % 2 == 0,
    lambda i, j: j % 3 == 0,
    lambda i, j: (i + j) % 3 == 0,
    lambda i, j: (i // 2 + j // 3) % 2 == 0,
    lambda i, j: (i * j) % 2 + (i * j) % 3 == 0,
    lambda i, j: ((i * j) % 2 + (i * j) % 3) % 2 == 0,
    lambda i, j: ((i * j) % 3 + (i + j) % 2) % 2 == 0,
)


def _payload(n: int, seed: int) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice(ALPHABET) for _ in range(n))


def _version(matrix) -> int:
    return (len(matrix) - 17) // 4


def _gf2_mod(value: int, generator: int) -> int:
    top = generator.bit_length()
    while value.bit_length() >= top:
        value ^= generator << (value.bit_length() - top)
    return value


def _format_cells(size: int):
    """(row, col) of format bits 14..0 (most significant first), per copy, from the standard's figure 25."""
    first = [(8, c) for c in (0, 1, 2, 3, 4, 5, 7, 8)] + [(r, 8) for r in (7, 5, 4, 3, 2, 1, 0)]
    second = [(r, 8) for r in range(size - 1, size - 8, -1)] + [(8, c) for c in range(size - 8, size)]
    return first, second


def _read_format(matrix) -> tuple[int, int]:
    size = len(matrix)
    out = []
    for cells in _format_cells(size):
        value = 0
        for r, c in cells:
            value = value << 1 | matrix[r][c]
        out.append(value)
    return out[0], out[1]


def _decode_format(raw: int) -> tuple[str, int]:
    value = raw ^ 0x5412
    assert _gf2_mod(value, 0x537) == 0, f"format BCH check failed: {raw:015b}"
    return ECC_FROM_BITS[value >> 13], (value >> 10) & 7


def _read_version_blocks(matrix) -> tuple[int, int]:
    size = len(matrix)
    top_right = bottom_left = 0
    for i in range(17, -1, -1):
        top_right = top_right << 1 | matrix[i // 3][size - 11 + i % 3]
        bottom_left = bottom_left << 1 | matrix[size - 11 + i % 3][i // 3]
    return top_right, bottom_left


def _function_map(version: int) -> list[list[bool]]:
    """Function modules (finders + separators + format areas, timing, alignment, version info, dark module)."""
    size = 17 + 4 * version
    f = [[False] * size for _ in range(size)]

    def box(r0, c0, r1, c1):
        for r in range(max(r0, 0), min(r1, size - 1) + 1):
            for c in range(max(c0, 0), min(c1, size - 1) + 1):
                f[r][c] = True

    box(0, 0, 8, 8)  # top-left finder, separator and format area
    box(0, size - 8, 8, size - 1)
    box(size - 8, 0, size - 1, 8)
    box(6, 0, 6, size - 1)
    box(0, 6, size - 1, 6)
    centres = ALIGNMENT.get(version, qr._alignment_positions(version))
    for r in centres:
        for c in centres:
            if (r, c) not in ((6, 6), (6, centres[-1]), (centres[-1], 6)):  # those would overlap a finder
                box(r - 2, c - 2, r + 2, c + 2)
    if version >= 7:
        box(0, size - 11, 5, size - 9)
        box(size - 11, 0, size - 9, 5)
    return f


def _zigzag(size: int, func):
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for r in rows:
            for c in (col, col - 1):
                if not func[r][c]:
                    yield r, c
        upward = not upward
        col -= 2


def _gf_tables():
    exp, log = [0] * 512, [0] * 256
    x = 1
    for i in range(255):
        exp[i], log[x] = x, i
        x = (x << 1) ^ (0x11D if x & 0x80 else 0)
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


GF_EXP, GF_LOG = _gf_tables()


def _syndromes_zero(block: list[int], ecc_len: int) -> bool:
    for k in range(ecc_len):
        acc = 0
        for coef in block:  # Horner at alpha^k
            acc = (GF_EXP[GF_LOG[acc] + k] if acc else 0) ^ coef
        if acc:
            return False
    return True


def _read_back(matrix) -> tuple[str, int, bytes]:
    """Unmask, collect codewords, de-interleave, verify every block's RS syndromes, parse the byte segment."""
    version = _version(matrix)
    size = len(matrix)
    a, b = _read_format(matrix)
    ecc, mask = _decode_format(a)
    assert _decode_format(b) == (ecc, mask)
    func = _function_map(version)
    bits = [matrix[r][c] ^ MASKS[mask](r, c) for r, c in _zigzag(size, func)]
    if version in TOTAL_CODEWORDS:
        assert len(bits) == TOTAL_CODEWORDS[version] * 8 + REMAINDER_BITS[version]
    codewords = [int("".join("1" if x else "0" for x in bits[i : i + 8]), 2) for i in range(0, len(bits) // 8 * 8, 8)]
    ecc_len, lengths = qr._block_structure(version, ecc)
    blocks: list[list[int]] = [[] for _ in lengths]
    pos = 0
    for i in range(max(lengths)):
        for k, n in enumerate(lengths):
            if i < n:
                blocks[k].append(codewords[pos])
                pos += 1
    for _ in range(ecc_len):
        for block in blocks:
            block.append(codewords[pos])
            pos += 1
    assert pos == len(codewords)
    for block in blocks:
        assert _syndromes_zero(block, ecc_len)
    data = [x for block, n in zip(blocks, lengths, strict=True) for x in block[:n]]
    stream = "".join(f"{x:08b}" for x in data)
    assert stream[:4] == "0100"
    count_bits = 8 if version <= 9 else 16
    count = int(stream[4 : 4 + count_bits], 2)
    start = 4 + count_bits
    payload = bytes(int(stream[start + 8 * i : start + 8 * i + 8], 2) for i in range(count))
    return ecc, mask, payload


# ---- structure ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("version", [1, 2, 5, 7, 10, 14, 15, 25, 32, 36, 40])
@pytest.mark.parametrize("ecc", ["L", "M", "Q", "H"])
def test_structure_at_each_version(version, ecc):
    n = qr.byte_capacity(version, ecc)
    m = qr.encode(_payload(n, version * 7 + ord(ecc)), ecc)
    size = len(m)
    assert size == 17 + 4 * version and all(len(row) == size for row in m)
    assert all(isinstance(x, bool) for row in m for x in row)
    # three finder patterns with light separators
    for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
        for dr in range(7):
            for dc in range(7):
                assert m[r0 + dr][c0 + dc] == (max(abs(dr - 3), abs(dc - 3)) != 2)
    for i in range(8):
        assert not m[7][i] and not m[i][7]  # top-left
        assert not m[7][size - 1 - i] and not m[i][size - 8]  # top-right
        assert not m[size - 8][i] and not m[size - 1 - i][7]  # bottom-left
    # timing patterns
    for i in range(8, size - 8):
        assert m[6][i] == (i % 2 == 0) and m[i][6] == (i % 2 == 0)
    assert m[size - 8][8]  # dark module
    # alignment patterns
    centres = ALIGNMENT.get(version)
    if centres is not None:
        assert qr._alignment_positions(version) == centres
        for r in centres:
            for c in centres:
                if (r, c) in ((6, 6), (6, centres[-1]), (centres[-1], 6)):
                    continue
                for dr in range(-2, 3):
                    for dc in range(-2, 3):
                        assert m[r + dr][c + dc] == (max(abs(dr), abs(dc)) != 1)
    # format information: both copies equal, BCH-valid, carry the requested level
    a, b = _read_format(m)
    assert a == b
    got_ecc, mask = _decode_format(a)
    assert got_ecc == ecc and 0 <= mask <= 7
    assert a == FORMAT_TABLE[ecc][mask]
    # version information for v7+
    if version >= 7:
        tr, bl = _read_version_blocks(m)
        assert tr == bl
        assert tr >> 12 == version and _gf2_mod(tr, 0x1F25) == 0
        if version in VERSION_INFO:
            assert tr == VERSION_INFO[version]


@pytest.mark.parametrize("version", sorted(TOTAL_CODEWORDS))
def test_data_module_count_matches_iso_table(version):
    func = _function_map(version)
    data_modules = sum(not x for row in func for x in row)
    assert data_modules == TOTAL_CODEWORDS[version] * 8 + REMAINDER_BITS[version]
    assert qr._num_raw_modules(version) == data_modules
    # and the module's own function-pattern map agrees with the independent one
    assert [list(row) for row in qr._template(version)[1]] == func


def test_capacity_table_and_version_selection():
    for version, caps in BYTE_CAPACITY.items():
        assert tuple(qr.byte_capacity(version, e) for e in "LMQH") == caps
    for ecc in "LMQH":
        for version in (1, 2, 9, 10, 26, 40):
            n = qr.byte_capacity(version, ecc)
            assert _version(qr.encode(b"a" * n, ecc)) == version
            if version < 40:
                assert _version(qr.encode(b"a" * (n + 1), ecc)) == version + 1
    with pytest.raises(ValueError):
        qr.encode(b"a" * 2954, "L")
    with pytest.raises(ValueError):
        qr.encode("a" * 1274, "H")
    with pytest.raises(ValueError):
        qr.encode("x", "X")
    with pytest.raises(ValueError):
        qr.encode("x", mask=8)
    with pytest.raises(TypeError):
        qr.encode(123)  # type: ignore[arg-type]
    assert qr.encode("x", "q") == qr.encode("x", "Q")


def test_block_structure_matches_iso_table():
    assert qr._block_structure(1, "H") == (17, [9])
    assert qr._block_structure(5, "Q") == (18, [15, 15, 16, 16])
    assert qr._block_structure(10, "M") == (26, [43] * 4 + [44])
    assert qr._block_structure(40, "H") == (30, [15] * 20 + [16] * 61)
    assert qr._block_structure(40, "L") == (30, [118] * 19 + [119] * 6)
    for version in range(1, 41):
        for ecc in "LMQH":
            ecc_len, lengths = qr._block_structure(version, ecc)
            assert sum(lengths) + ecc_len * len(lengths) == qr._num_raw_modules(version) // 8
            assert max(lengths) - min(lengths) <= 1


def test_reed_solomon_known_answers():
    # "HELLO WORLD" 1-M (alphanumeric) data codewords and their ten EC codewords.
    data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    assert qr._rs_remainder(data, qr._rs_divisor(10)) == [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]
    # Generator polynomial for 7 EC codewords, as exponents of alpha (leading x^7 omitted).
    assert [qr._GF_LOG[c] for c in qr._rs_divisor(7)] == [87, 229, 146, 149, 238, 102, 21]
    assert qr._gf_mul(0x80, 2) == 0x1D and qr._gf_mul(0, 7) == 0


def test_format_and_version_bits_match_iso_tables():
    for ecc, row in FORMAT_TABLE.items():
        for mask, expected in enumerate(row):
            assert qr._format_bits(ecc, mask) == expected
            assert _decode_format(expected) == (ecc, mask)
    for version, expected in VERSION_INFO.items():
        assert qr._version_bits(version) == expected


def test_masks_and_format_info_for_forced_masks():
    version = _version(qr.encode(PAIRING_URL))
    func = _function_map(version)
    fmt_cells = {cell for copy in _format_cells(17 + 4 * version) for cell in copy}
    variants = [qr.encode(PAIRING_URL, "M", mask=k) for k in range(8)]
    for k, m in enumerate(variants):
        assert _decode_format(_read_format(m)[0]) == ("M", k)
    base = variants[0]
    for k in range(1, 8):
        for r, row in enumerate(variants[k]):
            for c, x in enumerate(row):
                diff = x != base[r][c]
                if (r, c) in fmt_cells:
                    continue
                if func[r][c]:
                    assert not diff
                else:
                    assert diff == (MASKS[k](r, c) != MASKS[0](r, c))


def test_best_mask_has_the_lowest_penalty():
    for text, ecc in ((PAIRING_URL, "M"), ("HELLO WORLD", "Q"), (_payload(500, 3), "L")):
        chosen = qr.encode(text, ecc)
        size = len(chosen)

        def score(m, size=size):
            return qr._penalty([int("".join("1" if x else "0" for x in row), 2) for row in m], size)

        scores = [score(qr.encode(text, ecc, mask=k)) for k in range(8)]
        _, mask = _decode_format(_read_format(chosen)[0])
        assert scores[mask] == min(scores)
        assert chosen == qr.encode(text, ecc, mask=mask)


@pytest.mark.parametrize(
    ("text", "ecc"),
    [
        ("", "M"),
        ("HELLO WORLD", "Q"),
        (PAIRING_URL, "M"),
        ("Příliš žluťoučký kůň úpěl ďábelské ódy", "H"),
        (bytes(range(256)), "L"),
        (_payload(qr.byte_capacity(40, "M"), 40), "M"),
        (_payload(qr.byte_capacity(13, "Q") + 1, 14), "Q"),
    ],
)
def test_pure_python_read_back(text, ecc):
    m = qr.encode(text, ecc)
    got_ecc, _, payload = _read_back(m)
    assert got_ecc == ecc
    assert payload == (text.encode("utf-8") if isinstance(text, str) else text)


def test_pairing_payload_size():
    assert len(PAIRING_URL) == 135
    assert _version(qr.encode(PAIRING_URL)) == 8
    assert 8 <= _version(qr.encode(PAIRING_URL + "&x=" + "0" * 50)) <= 10


def test_encode_is_fast():
    text = _payload(200, 1)
    qr.encode(text)  # warm the per-version caches
    best = min(_timed(lambda: qr.encode(text)) for _ in range(5))
    assert best < 0.1, f"encoding 200 bytes took {best * 1000:.1f} ms"


def _timed(fn) -> float:
    t = time.perf_counter()
    fn()
    return time.perf_counter() - t


# ---- SVG ---------------------------------------------------------------------------------------------------------


def _svg_cells(d: str, border: int) -> set[tuple[int, int]]:
    """Rasterise the path back to dark (row, col) cells; it only uses M/m, h, v1, z."""
    cells: set[tuple[int, int]] = set()
    x = y = sx = sy = 0
    for cmd, a, b in re.findall(r"([MmhvzZ])(-?\d*)(?: (-?\d+))?", d):
        if cmd == "M":
            x, y = int(a), int(b)
            sx, sy = x, y
        elif cmd == "m":
            x, y = x + int(a), y + int(b)
            sx, sy = x, y
        elif cmd == "h":
            n = int(a)
            if n > 0:
                cells.update((y - border, c - border) for c in range(x, x + n))
            x += n
        elif cmd == "v":
            assert int(a) == 1
        else:
            x, y = sx, sy
    return cells


@pytest.mark.parametrize("border", [0, 4])
def test_svg_matches_matrix(border):
    out = qr.svg(PAIRING_URL, "M", border=border, title='Pair <NEBULA> & "you"')
    root = ET.fromstring(out)
    ns = "{http://www.w3.org/2000/svg}"
    m = qr.encode(PAIRING_URL, "M")
    dim = len(m) + 2 * border
    assert root.tag == f"{ns}svg"
    assert root.get("viewBox") == f"0 0 {dim} {dim}"
    assert root.get("width") == "100%" and root.get("height") == "100%"
    assert root.get("shape-rendering") == "crispEdges"
    assert root.find(f"{ns}title").text == 'Pair <NEBULA> & "you"'
    assert "&lt;NEBULA&gt; &amp;" in out
    rect = root.find(f"{ns}rect")
    assert rect.get("fill") == "#fff" and rect.get("width") == str(dim)
    paths = root.findall(f"{ns}path")
    assert len(paths) == 1 and paths[0].get("fill") == "#000"
    expected = {(r, c) for r, row in enumerate(m) for c, x in enumerate(row) if x}
    assert _svg_cells(paths[0].get("d"), border) == expected
    assert "<script" not in out and "href" not in out and "url(" not in out
    assert len(out) < 10_000


def test_svg_rejects_negative_border():
    with pytest.raises(ValueError):
        qr.svg("x", border=-1)


# ---- real decoder: CoreImage ---------------------------------------------------------------------------------------


def _write_png(matrix, path: Path, scale: int = 8, border: int = 4) -> None:
    dim = (len(matrix) + 2 * border) * scale
    margin = b"\xff" * (border * scale)
    blank = b"\x00" + b"\xff" * dim
    rows = [blank] * (border * scale)
    for row in matrix:
        line = b"\x00" + margin + b"".join(b"\x00" * scale if x else b"\xff" * scale for x in row) + margin
        rows.extend([line] * scale)
    rows += [blank] * (border * scale)

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))

    ihdr = struct.pack(">IIBBBBB", dim, dim, 8, 0, 0, 0, 0)  # 8-bit greyscale
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 6))
    path.write_bytes(png + chunk(b"IEND", b""))


SWIFT_DECODER = """
import CoreImage
import Foundation

let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil,
                          options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
var results: [[String]] = []
for path in CommandLine.arguments.dropFirst() {
    var found: [String] = []
    if let image = CIImage(contentsOf: URL(fileURLWithPath: path)) {
        for case let feature as CIQRCodeFeature in detector.features(in: image) {
            found.append(feature.messageString ?? "<nil>")
        }
    }
    results.append(found)
}
let data = try! JSONSerialization.data(withJSONObject: results)
FileHandle.standardOutput.write(data)
"""

# (version, ecc, fill): "max" fills the version completely, "min" is one byte more than the previous version holds.
COREIMAGE_CASES = [
    (1, "L", "max"), (1, "M", "max"), (1, "Q", "max"), (1, "H", "max"),
    (2, "L", "min"), (2, "H", "max"),
    (5, "M", "max"), (5, "Q", "min"),
    (7, "L", "max"), (7, "H", "min"),
    (10, "L", "min"), (10, "M", "max"), (10, "Q", "max"), (10, "H", "min"),
    (15, "M", "min"), (15, "H", "max"),
    (25, "L", "max"), (25, "Q", "min"),
    (40, "L", "max"), (40, "M", "max"), (40, "Q", "max"), (40, "H", "max"),
]


@pytest.mark.skipif(shutil.which("swift") is None and not Path("/usr/bin/swift").exists(), reason="needs swift")
def test_coreimage_decodes_every_payload(tmp_path):
    cases: list[tuple[str, str, str, int | None]] = []  # (label, payload, ecc, forced mask)
    for i, (version, ecc, fill) in enumerate(COREIMAGE_CASES):
        n = qr.byte_capacity(version, ecc) if fill == "max" else qr.byte_capacity(version - 1, ecc) + 1
        cases.append((f"v{version}-{ecc}-{fill}", _payload(n, 1000 + i), ecc, None))
    cases.append(("pairing-M", PAIRING_URL, "M", None))
    cases.append(("hello-Q", "HELLO WORLD", "Q", None))
    cases.append(("url-H", "https://example.com/pair?x=1", "H", None))
    cases.append(("utf8-M", "Příliš žluťoučký kůň úpěl ďábelské ódy", "M", None))  # UTF-8 bytes, no ECI
    cases.append(("utf8-Q", "NEBULA – párování zařízení ✓", "Q", None))
    cases += [(f"pairing-M-mask{k}", PAIRING_URL, "M", k) for k in range(8)]

    files, versions = [], {}
    for idx, (label, text, ecc, mask) in enumerate(cases):
        m = qr.encode(text, ecc, mask=mask)
        versions[label] = _version(m)
        if label.startswith("v"):
            assert versions[label] == int(label[1:].split("-")[0])
        path = tmp_path / f"{idx:02d}-{label}.png"
        _write_png(m, path)
        files.append(str(path))
    script = tmp_path / "decode.swift"
    script.write_text(SWIFT_DECODER)
    swift = shutil.which("swift") or "/usr/bin/swift"
    proc = subprocess.run(
        [swift, "-module-cache-path", str(tmp_path / "mc"), str(script), *files],
        capture_output=True, text=True, timeout=600, check=False,
    )
    if proc.returncode != 0 and ("xcrun: error" in proc.stderr or "developer path" in proc.stderr):
        pytest.skip(f"no usable Swift toolchain: {proc.stderr.strip()[:200]}")
    assert proc.returncode == 0, proc.stderr[-2000:]
    decoded = json.loads(proc.stdout)
    assert len(decoded) == len(cases)
    failures = [
        f"{label} (v{versions[label]}): got {[s[:40] for s in got]}"
        for (label, text, _, _), got in zip(cases, decoded, strict=True)
        if got != [text]
    ]
    assert not failures, "CoreImage could not round-trip:\n" + "\n".join(failures)
    assert set(versions.values()) >= {1, 2, 5, 7, 8, 10, 15, 25, 40}
