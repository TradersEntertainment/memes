import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
