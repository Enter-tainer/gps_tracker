// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/gps_tracker/',
  root: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
  },
  server: {
    port: 3000,
    open: true,
  }
});