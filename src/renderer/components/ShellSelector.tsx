import React, { useId, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { addTab } from '../store/slices/tabsSlice';
import { useDialogA11y, Mnemonic as MnemonicType } from './UI/useDialogA11y';
import { Mnemonic } from './UI/Mnemonic';
import './ShellSelector.css';
import { generateId } from '../utils/id';

interface ShellSelectorProps {
  onClose: () => void;
}

export const ShellSelector: React.FC<ShellSelectorProps> = ({ onClose }) => {
  const dispatch = useDispatch();
  const shellProfiles = useSelector((state: RootState) => state.settings.shellProfiles);
  const tabs = useSelector((state: RootState) => state.tabs.tabs);
  const [selectedShell, setSelectedShell] = useState(shellProfiles[0]?.id || '');
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const handleCreateTab = () => {
    if (!selectedShell) return;

    const shell = shellProfiles.find(s => s.id === selectedShell);
    if (!shell) return;

    const newTab = {
      id: generateId('tb'),
      title: `${shell.name} ${tabs.length + 1}`,
      shellType: shell.id,
      icon: '🖥️',
    };

    dispatch(addTab(newTab));
    onClose();
  };

  // No text input here (shell choice is radios), so the bare-letter mnemonics
  // stay active even while a radio is focused.
  const mnemonics: MnemonicType[] = [
    { key: 'C', handler: handleCreateTab },
    { key: 'A', handler: onClose },
  ];

  useDialogA11y(containerRef, {
    isOpen: true,
    onCancel: onClose,
    onEnter: handleCreateTab,
    mnemonics,
    initialFocus: 'first',
  });

  return (
    <div className="shell-selector-overlay" onClick={onClose}>
      <div
        className="shell-selector"
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>Select Shell Type</h3>
        <div className="shell-list">
          {shellProfiles.map((shell) => (
            <label key={shell.id} className="shell-option">
              <input
                type="radio"
                name="shell"
                value={shell.id}
                checked={selectedShell === shell.id}
                onChange={(e) => setSelectedShell(e.target.value)}
              />
              <span className="shell-name">{shell.name}</span>
              <span className="shell-path">{shell.path}</span>
            </label>
          ))}
        </div>
        <div className="shell-selector-actions">
          <button onClick={handleCreateTab} className="primary" data-dialog-confirm>
            <Mnemonic label="Create Terminal" char="C" />
          </button>
          <button onClick={onClose} data-dialog-cancel>
            <Mnemonic label="Cancel" char="A" />
          </button>
        </div>
      </div>
    </div>
  );
};
