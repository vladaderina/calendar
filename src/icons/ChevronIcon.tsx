import type { FC, CSSProperties } from 'react';

// Bigger, bolder chevrons for the nav arrows / expand markers.
export const ChevronIcon: FC<{ dir: 'left' | 'right' | 'down' | 'up'; style?: CSSProperties }> = ({ dir, style }) => (
  <svg style={style} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {dir === 'left' ? <path d="M15 5l-7 7 7 7" />
      : dir === 'right' ? <path d="M9 5l7 7-7 7" />
      : dir === 'up' ? <path d="M19 15l-7-7-7 7" />
      : <path d="M9 9l3 3 3-3" />}
  </svg>
);
