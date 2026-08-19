import { defineConfig, build as viteBuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const CONTENT_SCRIPTS = ['ax-extractor', 'dom-observer', 'human-input', 'perception'] as const;

function contentScriptBuilds(): Plugin {
  return {
    name: 'content-scripts-iife-builds',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      for (const name of CONTENT_SCRIPTS) {
        await viteBuild({
          configFile: false,
          build: {
            outDir: 'dist',
            emptyOutDir: false,
            minify: false, // Keep readable for debugging
            sourcemap: true,
            rollupOptions: {
              input: {
                [`content/${name}`]: resolve(__dirname, `src/content/${name}.ts`),
              },
              output: {
                format: 'iife',
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name].js',
                assetFileNames: 'assets/[name].[ext]',
              },
            },
          },
          resolve: {
            alias: {
              '@': resolve(__dirname, 'src'),
            },
          },
        });
      }
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  plugins: [react(), contentScriptBuilds()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    minify: false, // Keep readable for debugging
    sourcemap: true,
    rollupOptions: {
      input: {
        'sw/index': resolve(__dirname, 'src/sw/index.ts'),
        'sidepanel/index': resolve(__dirname, 'src/sidepanel/index.html'),
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
