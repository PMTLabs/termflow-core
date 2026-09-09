import React from 'react';

/** One eye for every canvas surface, so its two meanings cannot drift apart. */
export const EyeIcon: React.FC<{ slashed: boolean; size?: number }> = ({ slashed, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.3" fill="none" aria-hidden="true">
    <path d="M1.5 8s2.3-3.5 6.5-3.5S14.5 8 14.5 8 12.2 11.5 8 11.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.8" />
    {slashed && <path d="M2 2 14 14" />}
  </svg>
);

export default EyeIcon;
