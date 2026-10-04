// Minimal arrow icons for sunrise (↑) / sunset (↓).
// Black/white minimal style matching the rest of the calendar.
import type { JSX } from 'react';

interface IconProps {
  size?: number;
}

export function SunriseIcon({ size = 11 }: IconProps): JSX.Element {
  return <span style={{ fontSize: size, lineHeight: 1 }}>↑</span>;
}

export function SunsetIcon({ size = 11 }: IconProps): JSX.Element {
  return <span style={{ fontSize: size, lineHeight: 1 }}>↓</span>;
}
