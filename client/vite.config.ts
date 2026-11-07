import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:40333',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(__dirname, 'index.html'), persona: path.resolve(__dirname, 'persona.html') } },
  },
});
