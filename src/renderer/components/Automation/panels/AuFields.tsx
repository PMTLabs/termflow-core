/**
 * The inspector's field primitives (mockup §04).
 *
 * Small on purpose: four panels drawing the same radio three different ways is how a surface starts
 * looking like four surfaces. Nothing here knows what an automation is.
 */
import React from 'react';

export const AuField: React.FC<{ label: string; children: React.ReactNode }> = ({
    label,
    children,
}) => (
    <div className="au-fgroup">
        <span className="au-flabel">{label}</span>
        {children}
    </div>
);

export interface AuRadioProps {
    on: boolean;
    title: string;
    sub?: string;
    /** Shown in the warning colour under the label — §07's "Once you add a pattern…". */
    warn?: string;
    name: string;
    onPick: () => void;
}

export const AuRadio: React.FC<AuRadioProps> = ({ on, title, sub, warn, name, onPick }) => (
    <label className={`au-radio${on ? ' on' : ''}`}>
        <input type="radio" name={name} checked={on} onChange={onPick} />
        <span className="au-rmark" aria-hidden="true" />
        <span>
            {title}
            {sub && <span className="au-rsub">{sub}</span>}
            {warn && <span className="au-rsub warn">{warn}</span>}
        </span>
    </label>
);

export const AuCheck: React.FC<{
    on: boolean;
    label: string;
    /** A second line under the label, `au-radio`'s `sub` carried over to the checkbox row. */
    sub?: React.ReactNode;
    onToggle: () => void;
}> = ({ on, label, sub, onToggle }) => (
    <label className={`au-checkrow${on ? ' on' : ''}`}>
        <input type="checkbox" checked={on} onChange={onToggle} />
        <span className="au-cmark" aria-hidden="true">
            ✓
        </span>
        <span>
            {label}
            {sub && <span className="au-rsub">{sub}</span>}
        </span>
    </label>
);

export const AuHelp: React.FC<{ children: React.ReactNode; warn?: boolean }> = ({
    children,
    warn,
}) => <div className={`au-fhelp${warn ? ' warn' : ''}`}>{children}</div>;
