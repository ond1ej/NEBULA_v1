"""Dependency-free QR Code (Model 2) encoder for the dashboard's device-pairing code.

Byte mode only (a ``str`` is encoded as UTF-8), error-correction levels L/M/Q/H, versions 1-40, laid out per
ISO/IEC 18004: Reed-Solomon over GF(256) with the 0x11d field polynomial, block interleaving from the standard
tables, finder/timing/alignment patterns, BCH-coded format (masked with 0x5412) and version information, and the
best of the eight data masks by the four standard penalty rules.

``encode`` returns the module matrix as ``matrix[row][column]`` with ``True`` = dark (no quiet zone);
``svg`` renders it as a small standalone SVG that CSS can size.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from functools import cache
from html import escape

__all__ = ["ECC_LEVELS", "byte_capacity", "encode", "svg"]

ECC_LEVELS = ("L", "M", "Q", "H")
MIN_VERSION, MAX_VERSION = 1, 40

# Two-bit ECC level indicator used in the format information.
_ECC_FORMAT_BITS = {"L": 0b01, "M": 0b00, "Q": 0b11, "H": 0b10}

# ISO/IEC 18004 table 9, indexed by version (index 0 unused): error-correction codewords per block ...
_ECC_PER_BLOCK = {
    "L": (0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
          28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "M": (0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
          26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    "Q": (0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
          28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "H": (0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
          30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
}
# ... and the number of error-correction blocks.
_NUM_BLOCKS = {
    "L": (0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
          8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    "M": (0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
          17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
    "Q": (0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
          23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    "H": (0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
          25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
}

_FORMAT_MASK = 0x5412
_FORMAT_GENERATOR = 0x537  # x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
_VERSION_GENERATOR = 0x1F25  # x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1
_PAD_BYTES = (0xEC, 0x11)

# Data masks, (x, y) = (column, row); a module is inverted where the condition holds.
_MASKS: tuple[Callable[[int, int], bool], ...] = (
    lambda x, y: (x + y) % 2 == 0,
    lambda x, y: y % 2 == 0,
    lambda x, y: x % 3 == 0,
    lambda x, y: (x + y) % 3 == 0,
    lambda x, y: (x // 3 + y // 2) % 2 == 0,
    lambda x, y: x * y % 2 + x * y % 3 == 0,
    lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
)

# Penalty weights N1..N4 and the patterns they score.
_N1, _N2, _N3, _N4 = 3, 3, 40, 10
_RUN_RE = re.compile(r"0{5,}|1{5,}")
_FINDER_LIKE = ("00001011101", "10111010000")


# ---- GF(256) and Reed-Solomon ----------------------------------------------------------------------------------


def _gf_tables() -> tuple[tuple[int, ...], tuple[int, ...]]:
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return tuple(exp), tuple(log)


_GF_EXP, _GF_LOG = _gf_tables()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


@cache
def _rs_divisor(degree: int) -> tuple[int, ...]:
    """Coefficients of prod(x - a^i, 0 <= i < degree), highest power first, the leading 1 omitted."""
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 2)
    return tuple(result)


def _rs_remainder(data: list[int] | bytes, divisor: tuple[int, ...]) -> list[int]:
    """The error-correction codewords: data(x) * x^degree mod divisor(x)."""
    logs = [(i, _GF_LOG[c]) for i, c in enumerate(divisor) if c]
    result = [0] * len(divisor)
    for byte in data:
        factor = byte ^ result.pop(0)
        result.append(0)
        if factor:
            lf = _GF_LOG[factor]
            for i, lc in logs:
                result[i] ^= _GF_EXP[lc + lf]
    return result


# ---- version geometry ------------------------------------------------------------------------------------------


def _check_version(version: int) -> None:
    if not MIN_VERSION <= version <= MAX_VERSION:
        raise ValueError(f"QR version must be {MIN_VERSION}-{MAX_VERSION}, got {version}")


def _check_ecc(ecc: str) -> str:
    level = str(ecc).upper()
    if level not in _ECC_FORMAT_BITS:
        raise ValueError(f"ECC level must be one of L, M, Q, H, got {ecc!r}")
    return level


def _num_raw_modules(version: int) -> int:
    """Modules left for codewords (and remainder bits) after all function patterns of a version."""
    result = (16 * version + 128) * version + 64
    if version >= 2:
        n = version // 7 + 2
        result -= (25 * n - 10) * n - 55
        if version >= 7:
            result -= 36
    return result


def _num_data_codewords(version: int, ecc: str) -> int:
    return _num_raw_modules(version) // 8 - _ECC_PER_BLOCK[ecc][version] * _NUM_BLOCKS[ecc][version]


def _count_bits(version: int) -> int:
    """Width of the byte-mode character count indicator."""
    return 8 if version <= 9 else 16


def _block_structure(version: int, ecc: str) -> tuple[int, list[int]]:
    """(error-correction codewords per block, data codewords of each block in order)."""
    num_blocks = _NUM_BLOCKS[ecc][version]
    ecc_len = _ECC_PER_BLOCK[ecc][version]
    raw = _num_raw_modules(version) // 8
    num_short = num_blocks - raw % num_blocks
    short_data = raw // num_blocks - ecc_len
    return ecc_len, [short_data + (0 if i < num_short else 1) for i in range(num_blocks)]


def _alignment_positions(version: int) -> list[int]:
    if version == 1:
        return []
    n = version // 7 + 2
    size = version * 4 + 17
    step = (version * 8 + n * 3 + 5) // (n * 4 - 4) * 2
    return [6] + [size - 7 - i * step for i in range(n - 1)][::-1]


def byte_capacity(version: int, ecc: str = "M") -> int:
    """How many payload bytes fit in byte mode at this version and ECC level."""
    _check_version(version)
    level = _check_ecc(ecc)
    return (_num_data_codewords(version, level) * 8 - 4 - _count_bits(version)) // 8


# ---- format and version information ----------------------------------------------------------------------------


def _bch(value: int, generator: int, check_bits: int) -> int:
    """value followed by its BCH remainder modulo the generator polynomial."""
    rem = value << check_bits
    top = generator.bit_length()
    while rem.bit_length() >= top:
        rem ^= generator << (rem.bit_length() - top)
    return value << check_bits | rem


def _format_bits(ecc: str, mask: int) -> int:
    return _bch(_ECC_FORMAT_BITS[ecc] << 3 | mask, _FORMAT_GENERATOR, 10) ^ _FORMAT_MASK


def _version_bits(version: int) -> int:
    return _bch(version, _VERSION_GENERATOR, 12)


def _format_positions(size: int) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """(x, y) of format bits 0..14 (bit 0 = least significant) for the two copies."""
    first = [(8, i) for i in range(6)] + [(8, 7), (8, 8), (7, 8)] + [(14 - i, 8) for i in range(9, 15)]
    second = [(size - 1 - i, 8) for i in range(8)] + [(8, size - 15 + i) for i in range(8, 15)]
    return first, second


# ---- matrix construction ---------------------------------------------------------------------------------------


@cache
def _template(version: int) -> tuple[tuple[tuple[bool, ...], ...], tuple[tuple[bool, ...], ...]]:
    """(modules, is_function) with every function pattern drawn; format areas are reserved but left light."""
    size = version * 4 + 17
    modules = [[False] * size for _ in range(size)]
    func = [[False] * size for _ in range(size)]

    def put(x: int, y: int, dark: bool) -> None:
        modules[y][x] = dark
        func[y][x] = True

    for i in range(size):  # timing patterns
        put(6, i, i % 2 == 0)
        put(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):  # finders with their light separators
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    put(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    positions = _alignment_positions(version)
    last = len(positions) - 1
    for i, ax in enumerate(positions):
        for j, ay in enumerate(positions):
            if (i, j) in ((0, 0), (0, last), (last, 0)):  # these overlap the finders
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    put(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)
    for copy in _format_positions(size):
        for x, y in copy:
            put(x, y, False)
    put(8, size - 8, True)  # the dark module
    if version >= 7:
        bits = _version_bits(version)
        for i in range(18):
            dark = (bits >> i) & 1 == 1
            a, b = size - 11 + i % 3, i // 3
            put(a, b, dark)
            put(b, a, dark)
    return tuple(map(tuple, modules)), tuple(map(tuple, func))


@cache
def _mask_rows(version: int) -> tuple[tuple[int, ...], ...]:
    """Per mask, per row: an int whose bit (size-1-x) is set where module x is a data module the mask inverts."""
    func = _template(version)[1]
    size = len(func)
    return tuple(
        tuple(
            int("".join("1" if not func[y][x] and cond(x, y) else "0" for x in range(size)), 2)
            for y in range(size)
        )
        for cond in _MASKS
    )


def _format_rows(size: int, ecc: str, mask: int) -> dict[int, int]:
    """Row -> bits to OR in for the dark format modules of this ECC level and mask."""
    bits = _format_bits(ecc, mask)
    rows: dict[int, int] = {}
    for copy in _format_positions(size):
        for i, (x, y) in enumerate(copy):
            if (bits >> i) & 1:
                rows[y] = rows.get(y, 0) | 1 << (size - 1 - x)
    return rows


def _data_codewords(payload: bytes, version: int, ecc: str) -> list[int]:
    capacity_bits = _num_data_codewords(version, ecc) * 8
    count_bits = _count_bits(version)
    value = (0b0100 << count_bits | len(payload)) << 8 * len(payload) | int.from_bytes(payload, "big")
    nbits = 4 + count_bits + 8 * len(payload)
    terminator = min(4, capacity_bits - nbits)
    pad = (-(nbits + terminator)) % 8
    value <<= terminator + pad
    nbits += terminator + pad
    out = list(value.to_bytes(nbits // 8, "big"))
    for i in range(capacity_bits // 8 - len(out)):
        out.append(_PAD_BYTES[i % 2])
    return out


def _interleave(data: list[int], version: int, ecc: str) -> list[int]:
    ecc_len, lengths = _block_structure(version, ecc)
    divisor = _rs_divisor(ecc_len)
    data_blocks: list[list[int]] = []
    ecc_blocks: list[list[int]] = []
    k = 0
    for n in lengths:
        block = data[k : k + n]
        k += n
        data_blocks.append(block)
        ecc_blocks.append(_rs_remainder(block, divisor))
    out = [block[i] for i in range(max(lengths)) for block in data_blocks if i < len(block)]
    out += [block[i] for i in range(ecc_len) for block in ecc_blocks]
    return out


def _place_data(version: int, codewords: list[int]) -> list[list[bool]]:
    modules, func = _template(version)
    grid = [list(row) for row in modules]
    size = len(grid)
    total = len(codewords) * 8
    i = 0
    right = size - 1
    while right >= 1:  # two-column strips, right to left, alternating up and down, skipping the timing column
        if right == 6:
            right = 5
        upward = ((right + 1) & 2) == 0
        for vert in range(size):
            y = size - 1 - vert if upward else vert
            for x in (right, right - 1):
                if not func[y][x] and i < total:
                    grid[y][x] = (codewords[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2
    return grid  # any remainder bits stay light (0) before masking


def _penalty(rows: list[int], size: int) -> int:
    fmt = f"0{size}b"
    lines = [format(r, fmt) for r in rows]
    lines += ["".join(col) for col in zip(*lines, strict=True)]
    score = 0
    for line in lines:
        for run in _RUN_RE.finditer(line):  # rule 1: N1 + (run - 5) for each run of 5+ same-colour modules
            score += _N1 + len(run.group()) - 5
        padded = "0000" + line + "0000"  # rule 3: 1:1:3:1:1 finder-like runs with 4 light modules beside
        score += _N3 * (padded.count(_FINDER_LIKE[0]) + padded.count(_FINDER_LIKE[1]))
    full = (1 << size) - 1
    for a, b in zip(rows, rows[1:], strict=False):  # rule 2: each 2x2 block of one colour
        dark = a & b
        light = ~(a | b) & full
        score += _N2 * ((dark & dark >> 1).bit_count() + (light & light >> 1).bit_count())
    dark_count = sum(r.bit_count() for r in rows)  # rule 4: dark proportion away from 50 % in 5 % steps
    total = size * size
    score += _N4 * ((abs(dark_count * 20 - total * 10) + total - 1) // total - 1)
    return score


def encode(data: str | bytes, ecc: str = "M", *, mask: int | None = None) -> list[list[bool]]:
    """Encode ``data`` (a ``str`` as UTF-8) in byte mode at the smallest version that fits.

    Returns ``matrix[row][column]``, ``True`` = dark, without a quiet zone. ``mask`` forces one of the eight
    data masks (for testing); by default every mask is scored and the lowest penalty wins.
    Raises ``ValueError`` for an unknown ECC level or mask, or a payload too long for version 40.
    """
    if isinstance(data, str):
        payload = data.encode("utf-8")
    elif isinstance(data, bytes | bytearray | memoryview):
        payload = bytes(data)
    else:
        raise TypeError(f"data must be str or bytes, got {type(data).__name__}")
    level = _check_ecc(ecc)
    if mask is not None and mask not in range(8):
        raise ValueError(f"mask must be 0-7, got {mask!r}")
    for version in range(MIN_VERSION, MAX_VERSION + 1):
        if 4 + _count_bits(version) + 8 * len(payload) <= _num_data_codewords(version, level) * 8:
            break
    else:
        raise ValueError(
            f"payload of {len(payload)} bytes does not fit a QR code at ECC {level} "
            f"(max {byte_capacity(MAX_VERSION, level)} bytes)"
        )
    grid = _place_data(version, _interleave(_data_codewords(payload, version, level), version, level))
    size = len(grid)
    base = [int("".join("1" if m else "0" for m in row), 2) for row in grid]
    best: tuple[int, list[int]] | None = None
    for m in range(8) if mask is None else (mask,):
        rows = [b ^ k for b, k in zip(base, _mask_rows(version)[m], strict=True)]
        for y, bits in _format_rows(size, level, m).items():
            rows[y] |= bits
        score = _penalty(rows, size) if mask is None else 0
        if best is None or score < best[0]:
            best = (score, rows)
    assert best is not None
    fmt = f"0{size}b"
    return [[c == "1" for c in format(r, fmt)] for r in best[1]]


def svg(data: str | bytes, ecc: str = "M", border: int = 4, title: str = "NEBULA pairing") -> str:
    """A compact standalone SVG of the QR code: black modules on white, sized by CSS (100 % x 100 %)."""
    if border < 0:
        raise ValueError("border must be >= 0")
    matrix = encode(data, ecc)
    dim = len(matrix) + 2 * border
    parts: list[str] = []
    for y, row in enumerate(matrix):
        prev: int | None = None
        for run in re.finditer(r"1+", "".join("1" if m else "0" for m in row)):
            x, n = run.start(), run.end() - run.start()
            if prev is None:  # after "z" the pen is back at the run's start, so later runs move relatively
                parts.append(f"M{x + border} {y + border}h{n}v1h-{n}z")
            else:
                parts.append(f"m{x - prev} 0h{n}v1h-{n}z")
            prev = x
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" width="100%" height="100%" '
        f'shape-rendering="crispEdges" role="img"><title>{escape(title)}</title>'
        f'<rect width="{dim}" height="{dim}" fill="#fff"/><path fill="#000" d="{"".join(parts)}"/></svg>'
    )
