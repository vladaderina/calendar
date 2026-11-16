// Build only the store module (plus what it imports) for the node test.
// The Supabase endpoint is pointed at the local mock server below.
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __SUPABASE_URL__: JSON.stringify('http://127.0.0.1:4599'),
    __SUPABASE_ANON_KEY__: JSON.stringify('test-anon-key'),
  },
  build: {
    ssr: 'test/store-entry.ts',
    outDir: 'test/dist',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'store.mjs' },
    },
  },
});
