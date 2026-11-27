// The VM's memory on the Mac: the footprint (what macOS really attributes to the VM, ≈ 3 GB) when the host reports
// it; older hosts only report ps-style RSS (≈ 300 MB), which badly understates the VM.

export const VM_MEMORY_LABEL = 'VM memory (footprint)';

export function vmMemoryBytes(host: { vm_footprint_bytes?: number | null; vm_resident_bytes?: number | null } | null | undefined): number | null {
  if (!host) return null;
  if (typeof host.vm_footprint_bytes === 'number' && Number.isFinite(host.vm_footprint_bytes)) return host.vm_footprint_bytes;
  return typeof host.vm_resident_bytes === 'number' && Number.isFinite(host.vm_resident_bytes) ? host.vm_resident_bytes : null;
}

/** History sample in MB: footprint, falling back to RSS for rows recorded before the host measured the footprint. */
export function vmMemoryMb(row: { vm_footprint_mb?: number | null; vm_rss_mb?: number | null }): number | null {
  if (typeof row.vm_footprint_mb === 'number') return row.vm_footprint_mb;
  return typeof row.vm_rss_mb === 'number' ? row.vm_rss_mb : null;
}
