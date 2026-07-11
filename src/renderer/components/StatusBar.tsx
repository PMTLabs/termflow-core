import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import './StatusBar.css';

export const StatusBar: React.FC = () => {
  const activeTabId = useSelector((state: RootState) => state.tabs.activeTabId);
  const activeTab = useSelector((state: RootState) => 
    state.tabs.tabs.find(tab => tab.id === activeTabId)
  );

  return (
    <div className="status-bar">
      <div className="status-section">
        <span className="status-label">Shell:</span>
        <span className="status-value">{activeTab?.shellType || 'None'}</span>
      </div>
      <div className="status-section">
        <span className="status-label">Process:</span>
        <span className="status-value">{activeTab?.processId || 'N/A'}</span>
      </div>
      <div className="status-section status-right">
        <span className="status-value">Auto Terminal v0.1.0</span>
      </div>
    </div>
  );
};