import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration?: number;
    // Sticky toasts never auto-dismiss — they stay until the user clicks to close.
    // Used for activity notifications the user asked to acknowledge explicitly.
    sticky?: boolean;
    // The tab this toast refers to (activity notifications). Lets us auto-dismiss it
    // once the user opens that tab (e.g. by clicking the OS notification) — the toast
    // is redundant once the activity has been seen. See dismissTabToasts.
    tabId?: string;
}

interface DialogState {
    isOpen: boolean;
    title: string;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
    showConfirm?: boolean;
}

interface UIState {
    dialog: DialogState;
    toasts: Toast[];
}

const initialState: UIState = {
    dialog: {
        isOpen: false,
        title: '',
        message: '',
        type: 'info',
    },
    toasts: [],
};

const uiSlice = createSlice({
    name: 'ui',
    initialState,
    reducers: {
        showDialog: (state, action: PayloadAction<{ title: string; message: string; type?: 'info' | 'success' | 'warning' | 'error'; showConfirm?: boolean }>) => {
            state.dialog.isOpen = true;
            state.dialog.title = action.payload.title;
            state.dialog.message = action.payload.message;
            state.dialog.type = action.payload.type || 'info';
            state.dialog.showConfirm = action.payload.showConfirm;
        },
        hideDialog: (state) => {
            state.dialog.isOpen = false;
        },
        addToast: (state, action: PayloadAction<{ message: string; type?: ToastType; duration?: number; sticky?: boolean; tabId?: string }>) => {
            const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
            state.toasts.push({
                id,
                message: action.payload.message,
                type: action.payload.type || 'info',
                duration: action.payload.duration || 3000,
                sticky: action.payload.sticky,
                tabId: action.payload.tabId,
            });
        },
        removeToast: (state, action: PayloadAction<string>) => {
            state.toasts = state.toasts.filter(t => t.id !== action.payload);
        },
        // Dismiss every toast tied to a tab — used when the user opens that tab (e.g. via
        // clicking the OS notification), so the now-redundant in-app activity toast closes.
        dismissTabToasts: (state, action: PayloadAction<{ tabId: string }>) => {
            state.toasts = state.toasts.filter(t => t.tabId !== action.payload.tabId);
        },
    },
});

export const { showDialog, hideDialog, addToast, removeToast, dismissTabToasts } = uiSlice.actions;
export default uiSlice.reducer;
