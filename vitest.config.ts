import { defineConfig, type Plugin } from 'vitest/config';
import { resolve } from 'node:path';

// 工程配置（非计划源码）：
// 1. NodeNext ESM 规范要求 import 写 .js 后缀，但 vitest/vite 默认不把 .js
//    回落到 .ts 源文件——需插件做 .js→.ts 映射。
// 2. 计划测试文件 import 路径系统性少一层 ../（../../src 应为 ../../../src），
//    不改计划源码，用插件把 `若干../ + src/...` 统一解析到项目根 src/ 下。
// 两件事合成一个 resolveId 插件，不影响 node_modules 包导入。
function resolveProjectSource(rootDir: string): Plugin {
  return {
    name: 'resolve-project-source',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      if (source.startsWith('node:') || source.startsWith('@')) return null;
      if (!source.startsWith('.')) return null; // 只处理相对路径

      // 匹配：若干个 ../ + src/ + 后续路径 + .js
      // 例：../../src/core/event-bus/envelope.js
      //   → rootDir/src/core/event-bus/envelope.ts
      const m = source.match(/^(\.\.\/)+src\/(.+)\.js$/);
      if (m) {
        const subPath = m[2]; // core/event-bus/envelope
        const abs = resolve(rootDir, 'src', subPath) + '.ts';
        return abs;
      }

      // 匹配：若干个 ../ + src/ + 后续路径（无 .js 后缀，防御性）
      const m2 = source.match(/^(\.\.\/)+src\/(.+)$/);
      if (m2) {
        const subPath = m2[2];
        const abs = resolve(rootDir, 'src', subPath);
        return abs;
      }

      return null;
    },
  };
}

const rootDir = resolve(import.meta.dirname);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  plugins: [resolveProjectSource(rootDir)],
});
