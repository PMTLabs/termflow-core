import React from 'react';

const paths = {
  refresh: 'M13 7a5 5 0 1 0-.8 4.5M13 3v4H9',
  folder: 'M1.5 12.5v-8h4l1.5 1.5h7.5v6.5zM8 9.25h4M10 7.25v4',
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 9.5h4M8 7.5v4',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  chevron: 'M6 4l4 4-4 4',
  // Status bar metric glyphs (D101).
  server: 'M2.5 2.5h11v4.5h-11zM2.5 9h11v4.5h-11zM5 4.75h.01M5 11.25h.01',
  chip: 'M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14',
  memory: 'M1.5 4.5h13v5.5h-13zM4 6.5v1.5M6.75 6.5v1.5M9.25 6.5v1.5M12 6.5v1.5M3.5 10v2M6 10v2M10 10v2M12.5 10v2',
  clock: 'M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5M8 4.5V8l2.5 1.5',
  user: 'M8 2.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5M2.75 14c0-2.9 2.35-4.75 5.25-4.75s5.25 1.85 5.25 4.75',
  disk: 'M1.5 9.5l2-6h9l2 6v3.5h-13zM1.5 9.5h13M11.5 11.25h.01',
  networkDrive: 'M2 2h12v6h-12zM11.5 5h.01M8 8v3.25M2 13.25h4.75M9.25 13.25H14M8 11.25a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
};

export type SshIconName = keyof typeof paths;

export function SshIcon({ name, size = 16 }: { name: SshIconName; size?: number }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
