import React from 'react';

const paths = {
  refresh: 'M13 7a5 5 0 1 0-.8 4.5M13 3v4H9',
  folder: 'M1.5 12.5v-8h4l1.5 1.5h7.5v6.5zM8 9.25h4M10 7.25v4',
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 9.5h4M8 7.5v4',
  up: 'M8 13V3M4 7l4-4 4 4',
  chevron: 'M6 4l4 4-4 4',
};

export function SshIcon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
