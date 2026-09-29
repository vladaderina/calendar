import type { FC } from 'react';

// Bigger, bolder chevrons for the nav arrows.
export const ChevronIcon: FC<{ dir: 'left' | 'right' }> = ({ dir }) => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {dir === 'left' ? <path d="M15 5l-7 7 7 7" /> : <path d="M9 5l7 7-7 7" />}
  </svg>
);
