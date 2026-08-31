// 9.6 main.ts 是唯一的依赖注入点和启动入口
import { createSystem } from './system.js';
import { PanelHttpServer } from './panel-api/server.js';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const configDir = process.env.ULM_CONFIG_DIR || join(__dirname, '..', 'assets');
const dbDir = process.env.ULM_DB_DIR || join(__dirname, '..', 'store');
const wsPort = parseInt(process.env.ULM_WS_PORT || '8080', 10);
const panelPort = parseInt(process.env.ULM_PANEL_PORT || '8100', 10);

// better-sqlite3 不创建父目录：fresh clone / 自定义 dbDir 首次启动需先建
mkdirSync(dbDir, { recursive: true });

const system = createSystem({
  configDir,
  mode: 'production',
  wsPort,
  dbDir,
});

system.start();

// 驾驶舱首版（P 阶段）：面板 HTTP 面（REST + SSE + ui/ 静态托管），仅绑定 127.0.0.1
const panelServer = new PanelHttpServer(system, { port: panelPort });
await panelServer.start();

// 优雅关闭
process.on('SIGINT', () => {
  panelServer.stop();
  system.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  panelServer.stop();
  system.stop();
  process.exit(0);
});

console.log(`ulm-base 系统已启动，agent ws 端口 ${wsPort}，面板 ${panelServer.getAddress()}`);
