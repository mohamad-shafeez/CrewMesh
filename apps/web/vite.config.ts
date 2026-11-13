import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001';

const sharedProxy = {
  '/api': {
    target: apiProxyTarget,
    changeOrigin: false,
  },
  '/health': {
    target: apiProxyTarget,
    changeOrigin: false,
  },
  '/healthz': {
    target: apiProxyTarget,
    changeOrigin: false,
  },
  '/ready': {
    target: apiProxyTarget,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: sharedProxy,
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: sharedProxy,
  },
});
