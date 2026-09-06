/**
 * *+ New automation* opens this, not an empty canvas (mockup §02).
 *
 * Six ready-made rules plus a blank one. Every card says up front **which fields you'll change**, so
 * picking one is a decision you can make from this screen without opening it first.
 *
 * The sentence on each card is **derived** from the template's own rule by the same `describeRule`
 * the list row uses. Storing a display string beside the rule is how the mockup's rev 1 came to show
 * one rule on the canvas and a different one in the panel eight pixels away.
 */
import React from 'react';
import type { AutomationRule } from '../../../types/electron';
import { AUTOMATION_TEMPLATES, AutomationTemplate, blankDraft, draftFromTemplate } from './automationTemplates';
import { describeRule } from '../../Automation/automationDerive';
import { AuRuleSentence } from '../../Automation/AuRuleSentence';

export interface TemplateGalleryProps {
    onBack: () => void;
    onPick: (draft: AutomationRule, templateId: string) => void;
}

export const TemplateGallery: React.FC<TemplateGalleryProps> = ({ onBack, onPick }) => (
    <div className="au-panel">
        <div className="au-panelhead">
            <div className="au-panelhead-text">
                <h3>New automation</h3>
                <p>Start from a template and change what&apos;s yours, or build one from nothing.</p>
            </div>
            <button type="button" className="au-btn" onClick={onBack}>
                ← Back to the list
            </button>
        </div>

        <div className="au-tplgrid">
            {AUTOMATION_TEMPLATES.map((template) => (
                <TemplateCard
                    key={template.id}
                    template={template}
                    onPick={() => onPick(draftFromTemplate(template), template.id)}
                />
            ))}

            <button
                type="button"
                className="au-tplcard blank"
                onClick={() => onPick(blankDraft(), 'blank')}
            >
                <span className="au-tplhead">
                    <span className="au-gi blank" aria-hidden="true">+</span>
                    <span className="au-tt">Start from scratch</span>
                </span>
                <span className="au-tplbody">
                    <span className="au-tplwhy">
                        An empty canvas. Drag the steps in yourself — watch, read, compare, wait,
                        send. Everything a template does, you can do from here; it just takes longer.
                    </span>
                </span>
                <span className="au-tplfoot">
                    <span className="au-yc">You&apos;ll set</span>
                    <span className="au-editchip">every step</span>
                </span>
            </button>
        </div>

        <div className="au-tplnote">
            <span aria-hidden="true">ⓘ</span>
            <span>
                <b>A template arrives as a draft, switched off.</b> It fills in the pattern, the
                comparison and the message — the parts that are the same for everyone — and points
                itself at terminals <em>by description</em> rather than by a list you have to tick,
                so it is ready to run as soon as you switch it on. Nothing a template does can happen
                before that.
            </span>
        </div>
    </div>
);

/**
 * Exported for the both-surfaces test: the gallery's own cards are the six built-in templates, none
 * of which carries a wait step, so the surface cannot otherwise be shown a rule that has one.
 */
export const TemplateCard: React.FC<{ template: AutomationTemplate; onPick: () => void }> = ({
    template,
    onPick,
}) => {
    // The card describes the draft it will actually hand over, not the template's prose.
    const sentence = describeRule(draftFromTemplate(template));
    return (
        <button type="button" className="au-tplcard" onClick={onPick}>
            <span className="au-tplhead">
                <span className={`au-gi ${template.accent}`} aria-hidden="true">
                    ◉
                </span>
                <span className="au-tt">{template.title}</span>
            </span>
            <span className="au-tplbody">
                <span className="au-tplsay">
                    <AuRuleSentence sentence={sentence} stacked />
                </span>
                <span className="au-tplwhy">{template.why}</span>
            </span>
            <span className="au-tplfoot">
                <span className="au-yc">You&apos;ll change</span>
                {template.youllChange.map((field) => (
                    <span key={field} className="au-editchip">
                        {field}
                    </span>
                ))}
            </span>
        </button>
    );
};
