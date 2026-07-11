import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import authService from './authService';

// Create axios instance with base configuration
const axiosInstance = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:42031',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    // Note: Connection header is controlled by browser, cannot be set manually
  },
  // Set max concurrent requests to avoid overwhelming the server
  maxRedirects: 5,
});

// Request interceptor to add auth token
axiosInstance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = authService.getToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle auth errors
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    // If 401 and we haven't already tried to refresh
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const newToken = await authService.refreshToken();
        if (newToken && originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return axiosInstance(originalRequest);
        }
      } catch (refreshError) {
        // Refresh failed, redirect to login
        authService.logout();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    // If 403, user doesn't have permission
    if (error.response?.status === 403) {
      console.error('Permission denied:', error.response.data);
    }

    return Promise.reject(error);
  }
);

// Set default axios to use our configured instance
axios.defaults = axiosInstance.defaults;

export default axiosInstance;
