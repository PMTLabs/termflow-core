import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
} from '@mui/material';
import { login, clearError } from '../store/slices/authSlice';
import { AppDispatch, RootState } from '../store/store';

const Login: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const { isLoading, error, isAuthenticated } = useSelector(
    (state: RootState) => state.auth
  );
  const [clientId, setClientId] = useState('terminal-monitor');

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    dispatch(login({ clientId }));
  };

  const handleDismissError = () => {
    dispatch(clearError());
  };

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        backgroundColor: '#1e1e1e',
      }}
    >
      <Paper
        elevation={3}
        sx={{
          p: 4,
          width: '100%',
          maxWidth: 400,
          backgroundColor: '#2d2d2d',
        }}
      >
        <Typography
          variant="h4"
          component="h1"
          gutterBottom
          sx={{ color: '#fff', textAlign: 'center' }}
        >
          Terminal Monitor
        </Typography>
        <Typography
          variant="body2"
          sx={{ color: '#999', mb: 3, textAlign: 'center' }}
        >
          Connect to Auto-Terminal API
        </Typography>

        <form onSubmit={handleLogin}>
          <TextField
            fullWidth
            label="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            margin="normal"
            variant="outlined"
            sx={{
              '& .MuiInputBase-root': {
                color: '#fff',
              },
              '& .MuiOutlinedInput-notchedOutline': {
                borderColor: '#555',
              },
              '& .MuiInputLabel-root': {
                color: '#999',
              },
            }}
          />

          {error && (
            <Alert severity="error" onClose={handleDismissError} sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}

          <Button
            type="submit"
            fullWidth
            variant="contained"
            disabled={isLoading}
            sx={{
              mt: 3,
              py: 1.5,
              backgroundColor: '#0066cc',
              '&:hover': {
                backgroundColor: '#0052a3',
              },
            }}
          >
            {isLoading ? (
              <CircularProgress size={24} color="inherit" />
            ) : (
              'Connect'
            )}
          </Button>
        </form>

        <Typography
          variant="body2"
          sx={{ color: '#666', mt: 3, textAlign: 'center' }}
        >
          Make sure Auto-Terminal is running with --enable-api flag
        </Typography>
      </Paper>
    </Box>
  );
};

export default Login;
