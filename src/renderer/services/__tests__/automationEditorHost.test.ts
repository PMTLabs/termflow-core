import {
    requestAutomationList,
    consumePendingAutomationList,
    subscribeAutomationListRequested,
    requestAutomationLog,
    consumePendingAutomationLog,
    subscribeAutomationLogRequested,
    __resetAutomationEditorHostForTest,
} from '../automationEditorHost';

describe('automationEditorHost list request hand-off', () => {
    beforeEach(() => {
        __resetAutomationEditorHostForTest();
    });

    it('records a pending list request and consumes it exactly once', () => {
        expect(consumePendingAutomationList()).toBe(false);

        requestAutomationList();
        expect(consumePendingAutomationList()).toBe(true);
        expect(consumePendingAutomationList()).toBe(false);
    });

    it('notifies active subscribers when a list request is made and does not leave pending request', () => {
        const listener = jest.fn();
        const unsubscribe = subscribeAutomationListRequested(listener);

        requestAutomationList();
        expect(listener).toHaveBeenCalledTimes(1);
        // Live listener received it, so pending request should not be queued
        expect(consumePendingAutomationList()).toBe(false);

        unsubscribe();
        // Once unsubscribed, request is queued for future mount
        requestAutomationList();
        expect(consumePendingAutomationList()).toBe(true);
    });

    it('clears pending request on reset', () => {
        requestAutomationList();
        __resetAutomationEditorHostForTest();
        expect(consumePendingAutomationList()).toBe(false);
    });
});

describe('automationEditorHost log request hand-off', () => {
    beforeEach(() => {
        __resetAutomationEditorHostForTest();
    });

    it('records a pending log request and consumes it exactly once', () => {
        expect(consumePendingAutomationLog()).toBeNull();

        requestAutomationLog('rule-42');
        expect(consumePendingAutomationLog()).toBe('rule-42');
        expect(consumePendingAutomationLog()).toBeNull();
    });

    it('notifies active subscribers when a log request is made and does not leave pending request', () => {
        const listener = jest.fn();
        const unsubscribe = subscribeAutomationLogRequested(listener);

        requestAutomationLog('rule-42');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('rule-42');
        // Live listener received it, so pending request should not be queued
        expect(consumePendingAutomationLog()).toBeNull();

        unsubscribe();
        // Once unsubscribed, request is queued for future mount
        requestAutomationLog('rule-99');
        expect(consumePendingAutomationLog()).toBe('rule-99');
    });

    it('clears pending log request on reset', () => {
        requestAutomationLog('rule-42');
        __resetAutomationEditorHostForTest();
        expect(consumePendingAutomationLog()).toBeNull();
    });
});

