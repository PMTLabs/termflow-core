import { useState, useCallback } from 'react';
import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from '@mui/material';

interface ConfirmDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmColor?:
    | 'inherit'
    | 'primary'
    | 'secondary'
    | 'success'
    | 'error'
    | 'info'
    | 'warning';
}

interface ConfirmDialogState extends ConfirmDialogOptions {
  open: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export const useConfirmDialog = () => {
  const [dialogState, setDialogState] = useState<ConfirmDialogState>({
    open: false,
    title: 'Confirm Action',
    message: '',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    confirmColor: 'primary',
  });

  const confirm = useCallback(
    (options: ConfirmDialogOptions): Promise<boolean> => {
      return new Promise((resolve) => {
        setDialogState({
          open: true,
          title: options.title || 'Confirm Action',
          message: options.message,
          confirmText: options.confirmText || 'Confirm',
          cancelText: options.cancelText || 'Cancel',
          confirmColor: options.confirmColor || 'primary',
          onConfirm: () => {
            setDialogState((prev) => ({ ...prev, open: false }));
            resolve(true);
          },
          onCancel: () => {
            setDialogState((prev) => ({ ...prev, open: false }));
            resolve(false);
          },
        });
      });
    },
    []
  );

  const ConfirmDialog = useCallback(() => {
    const handleConfirm = () => {
      if (dialogState.onConfirm) {
        dialogState.onConfirm();
      }
    };

    const handleCancel = () => {
      if (dialogState.onCancel) {
        dialogState.onCancel();
      }
    };

    return (
      <Dialog
        open={dialogState.open}
        onClose={handleCancel}
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
      >
        <DialogTitle id="confirm-dialog-title">{dialogState.title}</DialogTitle>
        <DialogContent>
          <DialogContentText id="confirm-dialog-description">
            {dialogState.message}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel} color="inherit">
            {dialogState.cancelText}
          </Button>
          <Button
            onClick={handleConfirm}
            color={dialogState.confirmColor}
            autoFocus
            variant="contained"
          >
            {dialogState.confirmText}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }, [dialogState]);

  return { confirm, ConfirmDialog };
};
