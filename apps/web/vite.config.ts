import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base` matters: GitHub Pages serves a project site from `/<repo>/`, and assets requested from
 * `/` there 404 silently, producing a blank page that looks like a build failure.
 * Overridable so a local build and a custom-domain build both work.
 */
const base = process.env.VITE_BASE ?? '/caliper-triage/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    // The ONNX runtime that transformers.js pulls in is large and legitimately so.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          // Keep the model runtime out of the initial bundle: it is only fetched when a user
          // opts into on-device inference.
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
} as never);
