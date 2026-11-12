import React, { useState } from 'react';

export interface NewShellProfileInput {
  name: string;
  path: string;
  args: string[];
  cwd?: string;
}

/**
 * Split a command-line argument string into argv entries. Whitespace separates
 * arguments; double quotes group text containing spaces (`-NoLogo -Command "Get-Date -Format o"`).
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

interface AddShellProfileFormProps {
  onSubmit: (profile: NewShellProfileInput) => Promise<void>;
  onCancel: () => void;
  onBrowse?: () => Promise<string | null>;
}

/** Settings → Shell Profiles → "Add profile" form for a user-defined shell. */
export const AddShellProfileForm: React.FC<AddShellProfileFormProps> = ({ onSubmit, onCancel, onBrowse }) => {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleBrowse = async () => {
    const picked = await onBrowse?.();
    if (picked) {
      setPath(picked);
      if (!name.trim()) {
        const base = picked.split(/[\\/]/).pop() ?? '';
        setName(base.replace(/\.(exe|bat|cmd|com)$/i, ''));
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a name for the profile.');
      return;
    }
    if (!path.trim()) {
      setError('Enter the shell executable path.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        path: path.trim(),
        args: parseArgs(args),
        cwd: cwd.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="profile-card add-profile-form" onSubmit={handleSubmit} aria-label="Add shell profile">
      <div className="profile-header">
        <span className="profile-name">New profile</span>
      </div>

      <div className="cwd-input-group">
        <label className="setting-label" htmlFor="new-profile-name">Name</label>
        <input
          id="new-profile-name"
          type="text"
          className="setting-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nushell"
          autoFocus
        />
      </div>

      <div className="cwd-input-group">
        <label className="setting-label" htmlFor="new-profile-path">Executable</label>
        <div className="setting-input-group">
          <input
            id="new-profile-path"
            type="text"
            className="setting-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="e.g. C:\Program Files\nu\bin\nu.exe or nu.exe"
          />
          {onBrowse && (
            <button type="button" className="browse-btn" onClick={handleBrowse}>
              Browse…
            </button>
          )}
        </div>
      </div>

      <div className="cwd-input-group">
        <label className="setting-label" htmlFor="new-profile-args">Arguments</label>
        <input
          id="new-profile-args"
          type="text"
          className="setting-input"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder='Optional, e.g. -NoLogo or --login -i'
        />
        <span className="help-text">Separate with spaces; wrap an argument containing spaces in double quotes.</span>
      </div>

      <div className="cwd-input-group">
        <label className="setting-label" htmlFor="new-profile-cwd">Start In Directory</label>
        <input
          id="new-profile-cwd"
          type="text"
          className="setting-input"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Leave empty to use default"
        />
      </div>

      {error && <div className="add-profile-error" role="alert">{error}</div>}

      <div className="add-profile-actions">
        <button type="button" className="set-default-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="add-profile-submit" disabled={saving}>
          {saving ? 'Adding…' : 'Add profile'}
        </button>
      </div>
    </form>
  );
};
