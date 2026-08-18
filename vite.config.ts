import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false, // Keep readable for debugging
    sourcemap: true,
    rollupOptions: {
      input: {
        'sw/index': resolve(__dirname, 'src/sw/index.ts'),
        'content/ax-extractor': resolve(__dirname, 'src/content/ax-extractor.ts'),
        'content/dom-observer': resolve(__dirname, 'src/content/dom-observer.ts'),
        'content/human-input': resolve(__dirname, 'src/content/human-input.ts'),
        'content/perception': resolve(__dirname, 'src/content/perception.ts'),
        'sidepanel/index': resolve(__dirname, 'src/sidepanel/index.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        format: 'es',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});