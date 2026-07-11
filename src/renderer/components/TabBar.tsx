import React, { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { setActiveTab, removeTab } from '../store/slices/tabsSlice';
import { ShellSelector } from './ShellSelector';
import './TabBar.css';

export const TabBar: React.FC = () => {
  const dispatch = useDispatch();
  const { tabs, activeTabId } = useSelector((state: RootState) => state.tabs);
  const [showShellSelector, setShowShellSelector] = useState(false);

  const handleTabClick = (tabId: string) => {
    dispatch(setActiveTab(tabId));
  };

  const handleTabClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    dispatch(removeTab(tabId));
  };

  const handleNewTab = () => {
    setShowShellSelector(true);
  };

  return (
    <>
      <div className="tab-bar">
        <div className="tabs-container">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => handleTabClick(tab.id)}
            >
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-close"
                onClick={(e) => handleTabClose(e, tab.id)}
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button className="new-tab-button" onClick={handleNewTab} aria-label="New tab">
          +
        </button>
      </div>
      {showShellSelector && (
        <ShellSelector onClose={() => setShowShellSelector(false)} />
      )}
    </>
  );
};