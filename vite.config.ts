import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const hugeiconsEsm = path.resolve(
  root,
  'node_modules/@hugeicons/core-free-icons/dist/esm',
);

export default defineConfig({
  resolve: {
    alias: [
      {
        // Package exports omit most icons; map deep imports to real ESM files.
        find: /^@hugeicons\/core-free-icons\/(.+)$/,
        replacement: path.join(hugeiconsEsm, '$1.js'),
      },
    ],
  },
  server: {
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
  },
});
