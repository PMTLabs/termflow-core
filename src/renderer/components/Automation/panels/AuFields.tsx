/**
 * The inspector's field primitives (mockup §04).
 *
 * Small on purpose: five panels drawing the same radio three different ways is how a surface starts
 * looking like five surfaces. Nothing here knows what an automation is.
 */
import React from 'react';

export const AuField: React.FC<{
    label: string;
    /** An `AuInfo` for this field, drawn against the label. Optional — most fields say enough. */
    info?: React.ReactNode;
    children: React.ReactNode;
}> = ({ label, info, children }) => (
    <div className="au-fgroup">
        {/* Inside the label rather than beside it, so the icon travels with the words it explains
            and `.au-flabel`'s own block/margin rules keep applying to every field unchanged. */}
        <span className="au-flabel">
            {label}
            {info}
        </span>
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
    disabled?: boolean;
    /**
     * Drawn after the label text, e.g. an `AuInfo`. A button may not sit inside a `<label>`, so a
     * row with `extra` is a `div` whose checkbox is named by `htmlFor` labels instead.
     */
    extra?: React.ReactNode;
}> = ({ on, label, sub, onToggle, disabled, extra }) => {
    const id = React.useId();
    const className = `au-checkrow${on ? ' on' : ''}${disabled ? ' disabled' : ''}`;
    if (!extra) {
        return (
            <label className={className}>
                <input type="checkbox" checked={on} onChange={onToggle} disabled={disabled} />
                <span className="au-cmark" aria-hidden="true">
                    ✓
                </span>
                <span>
                    {label}
                    {sub && <span className="au-rsub">{sub}</span>}
                </span>
            </label>
        );
    }
    return (
        <div className={className}>
            <input
                id={id}
                type="checkbox"
                checked={on}
                onChange={onToggle}
                disabled={disabled}
                aria-describedby={sub ? `${id}-sub` : undefined}
            />
            <label htmlFor={id} className="au-cmark" aria-hidden="true">
                ✓
            </label>
            <span>
                <label htmlFor={id}>{label}</label>
                {extra}
                {/* A description, not a label: a label here would also join the accessible name. */}
                {sub && (
                    <span id={`${id}-sub`} className="au-rsub">
                        {sub}
                    </span>
                )}
            </span>
        </div>
    );
};

export const AuHelp: React.FC<{ children: React.ReactNode; warn?: boolean }> = ({
    children,
    warn,
}) => <div className={`au-fhelp${warn ? ' warn' : ''}`}>{children}</div>;
