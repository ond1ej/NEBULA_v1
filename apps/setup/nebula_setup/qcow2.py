"""Minimal, dependency-free QCOW2 -> sparse raw converter.

Apple Virtualization.framework boots raw disk images only. Ubuntu publishes its full
GPT/EFI cloud disk as (zlib-compressed) QCOW2, so we convert it ourselves instead of
requiring qemu-img on the user's Mac. Supports QCOW2 v2/v3, standard and zlib-compressed
clusters, zero clusters; refuses backing files, encryption, zstd and extended L2.
"""

from __future__ import annotations

import os
import struct
import zlib
from collections.abc import Callable
from dataclasses import dataclass

MAGIC = b"QFI\xfb"
QCOW_OFLAG_COPIED = 1 << 63
QCOW_OFLAG_COMPRESSED = 1 << 62
L1_OFFSET_MASK = 0x00FFFFFFFFFFFE00
L2_OFFSET_MASK = 0x00FFFFFFFFFFFE00


class QCOW2Error(Exception):
    pass


@dataclass
class Header:
    version: int
    cluster_bits: int
    size: int
    l1_size: int
    l1_table_offset: int
    crypt_method: int
    backing_file_offset: int
    incompatible_features: int
    compression_type: int

    @property
    def cluster_size(self) -> int:
        return 1 << self.cluster_bits


def read_header(f) -> Header:
    f.seek(0)
    raw = f.read(112)
    if raw[:4] != MAGIC:
        raise QCOW2Error("not a QCOW2 image")
    version, = struct.unpack(">I", raw[4:8])
    backing_off, = struct.unpack(">Q", raw[8:16])
    cluster_bits, = struct.unpack(">I", raw[20:24])
    size, = struct.unpack(">Q", raw[24:32])
    crypt, = struct.unpack(">I", raw[32:36])
    l1_size, = struct.unpack(">I", raw[36:40])
    l1_off, = struct.unpack(">Q", raw[40:48])
    incompat = 0
    compression_type = 0
    if version >= 3:
        incompat, = struct.unpack(">Q", raw[72:80])
        header_length, = struct.unpack(">I", raw[100:104])
        if header_length > 104:
            compression_type = raw[104]
    elif version != 2:
        raise QCOW2Error(f"unsupported qcow2 version {version}")
    return Header(version, cluster_bits, size, l1_size, l1_off, crypt, backing_off, incompat, compression_type)


def convert(src: str, dst: str, progress: Callable[[int, int], None] | None = None) -> dict:
    """Convert `src` QCOW2 into sparse raw `dst`. Returns stats."""
    with open(src, "rb") as f:
        h = read_header(f)
        if h.backing_file_offset:
            raise QCOW2Error("backing files are not supported")
        if h.crypt_method:
            raise QCOW2Error("encrypted images are not supported")
        if h.incompatible_features & ~0x1:  # bit0 = dirty is tolerable for a read-only copy
            raise QCOW2Error(f"unsupported incompatible features 0x{h.incompatible_features:x}")
        if h.compression_type != 0:
            raise QCOW2Error("only zlib compression is supported")
        if not 9 <= h.cluster_bits <= 21:
            raise QCOW2Error("invalid cluster size")
        cs = h.cluster_size
        l2_entries = cs // 8
        f.seek(h.l1_table_offset)
        l1 = struct.unpack(f">{h.l1_size}Q", f.read(8 * h.l1_size))
        csize_shift = 62 - (h.cluster_bits - 8)
        csize_mask = (1 << (h.cluster_bits - 8)) - 1
        coffset_mask = (1 << csize_shift) - 1

        tmp = dst + ".partial"
        written = 0
        data_clusters = 0
        zero = bytes(cs)
        with open(tmp, "wb") as out:
            out.truncate(h.size)
            total_clusters = (h.size + cs - 1) // cs
            done = 0
            for l1_index, l1e in enumerate(l1):
                l2_off = l1e & L1_OFFSET_MASK
                if not l2_off:
                    done += l2_entries
                    continue
                f.seek(l2_off)
                l2 = struct.unpack(f">{l2_entries}Q", f.read(cs))
                for l2_index, e in enumerate(l2):
                    guest_off = (l1_index * l2_entries + l2_index) * cs
                    if guest_off >= h.size:
                        break
                    done += 1
                    if e & QCOW_OFLAG_COMPRESSED:
                        host_off = e & coffset_mask
                        nb_sectors = ((e >> csize_shift) & csize_mask) + 1
                        length = nb_sectors * 512 - (host_off & 511)
                        f.seek(host_off)
                        comp = f.read(length)
                        d = zlib.decompressobj(-15)
                        data = d.decompress(comp, cs)
                        if len(data) != cs:
                            raise QCOW2Error(f"short compressed cluster at guest offset {guest_off}")
                    else:
                        if e & 1:  # zero cluster flag (v3)
                            continue
                        host_off = e & L2_OFFSET_MASK
                        if not host_off:
                            continue
                        f.seek(host_off)
                        data = f.read(cs)
                    if data == zero:
                        continue
                    chunk = data[: min(cs, h.size - guest_off)]
                    out.seek(guest_off)
                    out.write(chunk)
                    written += len(chunk)
                    data_clusters += 1
                if progress and l1_index % 4 == 0:
                    progress(min(done, total_clusters), total_clusters)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, dst)
        if progress:
            progress(1, 1)
        return {"virtual_size": h.size, "bytes_written": written, "data_clusters": data_clusters,
                "cluster_size": cs, "version": h.version}
