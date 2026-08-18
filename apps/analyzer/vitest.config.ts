import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'analyzer',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
