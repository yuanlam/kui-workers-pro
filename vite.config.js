import { lstatSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

function cleanUiAssetsPlugin() {
  let outDir = '';

  const isInside = (parent, child) => {
    const pathFromParent = relative(parent, child);
    return pathFromParent !== '' && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent);
  };

  const realDirectoryOrNull = target => {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  };

  const validateUiAssetsDir = bundleDir => {
    const uiAssetsDir = resolve(bundleDir, 'ui-assets');
    let uiAssetsStats;
    try {
      uiAssetsStats = lstatSync(uiAssetsDir);
    } catch {
      return null;
    }
    if (uiAssetsStats.isSymbolicLink()) {
      throw new Error('Refusing to build or clean ui-assets while it is a symbolic link');
    }

    const realOutDir = realDirectoryOrNull(outDir);
    const realBundleDir = realDirectoryOrNull(bundleDir);
    const realUiAssetsDir = realDirectoryOrNull(uiAssetsDir);
    if (!realOutDir || !realBundleDir || !realUiAssetsDir) return null;
    if (!isInside(realOutDir, realBundleDir) && realBundleDir !== realOutDir) return null;
    if (
      realUiAssetsDir !== resolve(realBundleDir, 'ui-assets')
      || !isInside(realOutDir, realUiAssetsDir)
    ) {
      return null;
    }
    return realUiAssetsDir;
  };

  return {
    name: 'clean-ui-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.build.outDir);
    },
    buildStart() {
      validateUiAssetsDir(outDir);
    },
    writeBundle(outputOptions, bundle) {
      const bundleDir = resolve(outputOptions.dir || outDir);
      if (!isInside(outDir, bundleDir) && bundleDir !== outDir) {
        throw new Error('Refusing to clean assets outside the configured output directory');
      }

      const realUiAssetsDir = validateUiAssetsDir(bundleDir);
      if (!realUiAssetsDir) return;

      const expectedFiles = new Set(
        Object.keys(bundle)
          .filter(fileName => fileName.startsWith('ui-assets/'))
          .map(fileName => basename(fileName)),
      );

      for (const entry of readdirSync(realUiAssetsDir, { withFileTypes: true })) {
        if (!entry.isFile() || expectedFiles.has(entry.name)) continue;
        const stalePath = resolve(realUiAssetsDir, entry.name);
        let staleStats;
        try {
          staleStats = lstatSync(stalePath);
        } catch {
          continue;
        }
        if (!staleStats.isFile()) continue;
        const realStalePath = realDirectoryOrNull(stalePath);
        if (realStalePath !== resolve(realUiAssetsDir, entry.name)) continue;
        rmSync(stalePath, { force: true });
      }
    },
  };
}

const devBackend = process.env.KUI_DEV_BACKEND || 'http://127.0.0.1:8787';

export default defineConfig({
  root: resolve(import.meta.dirname, 'frontend'),
  plugins: [vue(), cleanUiAssetsPlugin()],
  server: {
    host: process.env.VITE_HOST || '0.0.0.0',
    port: Number(process.env.VITE_PORT || 5173),
    proxy: {
      '/api': { target: devBackend, changeOrigin: false },
      '/dashboard': { target: devBackend, changeOrigin: false, ws: true },
      '/public': { target: devBackend, changeOrigin: false, ws: true },
      '/agent': { target: devBackend, changeOrigin: false, ws: true },
      '/health': { target: devBackend, changeOrigin: false },
      '/tailwind.css': { target: devBackend, changeOrigin: false },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'static'),
    emptyOutDir: false,
    assetsDir: 'ui-assets',
    rollupOptions: {
      output: {
        entryFileNames: 'ui-assets/[name]-[hash].js',
        chunkFileNames: 'ui-assets/[name]-[hash].js',
        assetFileNames: 'ui-assets/[name]-[hash][extname]',
      },
    },
  },
});
