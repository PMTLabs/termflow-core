import {
    requestAutomationList,
    consumePendingAutomationList,
    subscribeAutomationListRequested,
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
