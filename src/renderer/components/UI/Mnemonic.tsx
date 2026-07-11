import React from 'react';

export interface MnemonicProps {
  /** The full button/label text, e.g. "Close Tab". */
  label: string;
  /** The single character to underline, e.g. "C" (case-insensitive). */
  char: string;
  className?: string;
}

/**
 * Split `label` around the first case-insensitive occurrence of `char`.
 * Returns null when `char` is not a single character or is absent from `label`.
 */
export function splitMnemonic(
  label: string,
  char: string,
): { before: string; match: string; after: string } | null {
  if (!char || char.length !== 1) return null;
  const idx = label.toLowerCase().indexOf(char.toLowerCase());
  if (idx === -1) return null;
  return {
    before: label.slice(0, idx),
    match: label.slice(idx, idx + 1),
    after: label.slice(idx + 1),
  };
}

/**
 * Render a label with its mnemonic letter underlined, e.g.
 * `<Mnemonic label="Cancel" char="a" />` → c<u>a</u>ncel.
 * Falls back to the plain label (and a dev warning) if the char isn't found.
 */
export const Mnemonic: React.FC<MnemonicProps> = ({ label, char, className }) => {
  const parts = splitMnemonic(label, char);
  if (!parts) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`<Mnemonic>: char "${char}" not found in label "${label}"`);
    }
    return <span className={className}>{label}</span>;
  }
  return (
    <span className={className}>
      {parts.before}
      <u className="mnemonic-key">{parts.match}</u>
      {parts.after}
    </span>
  );
};
