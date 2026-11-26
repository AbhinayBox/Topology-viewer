import { defineConfig } from 'vite';

// Plain Vite config: vtk.js 38 ships ES modules, so no special loaders are needed.
export default defineConfig({
  base: './',               // relative URLs -> dist/ can be served from any folder or by wslink --content
  server: { host: '0.0.0.0', port: 5173 },
  build: { chunkSizeWarningLimit: 4000 },
});
