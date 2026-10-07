import type { FC, CSSProperties } from 'react';

// Minimalist refresh/sync icon, matching ChevronIcon style
export const RefreshIcon: FC<{ style?: CSSProperties }> = ({ style }) => (
  <svg
    style={style}
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
  </svg>
);
