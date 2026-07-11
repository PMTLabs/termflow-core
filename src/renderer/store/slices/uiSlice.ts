import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration?: number;
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
        addToast: (state, action: PayloadAction<{ message: string; type?: ToastType; duration?: number }>) => {
            const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
            state.toasts.push({
                id,
                message: action.payload.message,
                type: action.payload.type || 'info',
                duration: action.payload.duration || 3000,
            });
        },
        removeToast: (state, action: PayloadAction<string>) => {
            state.toasts = state.toasts.filter(t => t.id !== action.payload);
        },
    },
});

export const { showDialog, hideDialog, addToast, removeToast } = uiSlice.actions;
export default uiSlice.reducer;
