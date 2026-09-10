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

    it('notifies active subscribers when a list request is made', () => {
        const listener = jest.fn();
        const unsubscribe = subscribeAutomationListRequested(listener);

        requestAutomationList();
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        requestAutomationList();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('clears pending request on reset', () => {
        requestAutomationList();
        __resetAutomationEditorHostForTest();
        expect(consumePendingAutomationList()).toBe(false);
    });
});
