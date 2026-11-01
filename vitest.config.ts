import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['apps/**/*.test.ts', 'libs/**/*.test.ts'], exclude: ['**/node_modules/**'] },
});
