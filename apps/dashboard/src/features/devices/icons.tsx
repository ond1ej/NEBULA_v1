// Icons of the devices page (same 24 px grid / 1.7 px stroke as components/icons).
import { Base, type P } from '../../components/iconBase';

export const IconIphone = (p: P) => (
  <Base {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2.2" />
    <path d="M11 18.2h2" />
  </Base>
);

export const IconMac = (p: P) => (
  <Base {...p}>
    <rect x="4.5" y="5" width="15" height="10" rx="1.6" />
    <path d="M2.5 18.5h19" />
  </Base>
);

export const IconQr = (p: P) => (
  <Base {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2.5v2.5H14zM18.5 18.5H20V20h-1.5zM14 19.5V20M20 14v1.5" />
  </Base>
);
