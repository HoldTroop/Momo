import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'dist/**',
        'node_modules/**',
        'bridge/**',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
      thresholds: {
        'src/lib/**': {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
        'src/sw/**': {
          lines: 70,
          functions: 70,
          branches: 70,
          statements: 70,
        },
      },
    },
  },
});
