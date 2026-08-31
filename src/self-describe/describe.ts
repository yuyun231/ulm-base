import type { ProjectionsStore } from '../core/projector/projections-store.js';
import type { EventStore } from '../core/event-bus/store.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'yaml';
import { ORGAN_SUBTYPES, TASK_SUBTYPES, SCHEDULE_SUBTYPES, COMM_SUBTYPES, DIALOGUE_SUBTYPES, ADMIN_SUBTYPES, DOC_SUBTYPES } from '../core/event-bus/envelope.js';

// 澄清10：单一 describe() 返回全量结构化数据
// 设计文档 7.3：面板渲染的数据源 = self-describe 输出
// 7.6：基座确定性输出自身结构（F6 补全：模块清单+工作流+参数+事件族schema）
// 只读 ProjectionsStore + EventStore + configDir 资产，不产事件，不改变状态

export interface ModuleDescriptor {
  name: string;
  path: string;
  responsibility: string;
}

export interface WorkflowDescriptor {
  name: string;
  file: string;
}

// Phase F.5：工序模板描述（含解析内容，解析失败 → null）
export interface ProcedureDescriptor {
  name: string;
  file: string;
  template: any;
}

export interface EventFamilySchema {
  family: string;
  subtypes: readonly string[];
}

export interface SelfDescription {
  modules: ModuleDescriptor[];
  agents: any[];
  workflows: WorkflowDescriptor[];
  workflowContents: Record<string, string>;   // F.5：工作流文档内容（6.1 workflows/:agentId 查询面的快照形态）
  automations: any;                            // F.5：automations.yaml 解析视图（解析失败 → null）
  procedures: ProcedureDescriptor[];           // F.5：工序模板清单（含模板解析内容）
  params: Record<string, any>;
  permissions: any[];
  eventSchemas: EventFamilySchema[];
}

export interface SystemSnapshot extends SelfDescription {
  meta: { maxEventSeq: number; generatedAt: number; };
  tasks: any[];
  taskNodes: any[];
  agents: any[];
  workspaces: any[];
  loadQueue: any[];
  dialogues: any[];
  guidances: any[];
  consults: any[];
  purposes: any[];
  replayByPurpose: any[];
  valueCompare: any[];
  registry: any[];
  agentRegistry: any[];
  permissionRules: any[];
}

// 硬编码模块清单（模块是代码固定的）
const MODULES: ModuleDescriptor[] = [
  { name: 'event-bus', path: 'src/core/event-bus', responsibility: '事件总线+定序+存储' },
  { name: 'projector', path: 'src/core/projector', responsibility: '投影器+14张投影表' },
  { name: 'scheduler', path: 'src/core/scheduler', responsibility: '调度器规则机+状态机+加载区+定时器' },
  { name: 'permission', path: 'src/core/permission', responsibility: '权限校验点+规则加载' },
  { name: 'task-service', path: 'src/services/task', responsibility: '任务命令面+查询' },
  { name: 'comm-service', path: 'src/services/comm', responsibility: '征求决策命令+硬闸' },
  { name: 'doc-service', path: 'src/services/doc', responsibility: '查阅+准入+水印' },
  { name: 'dialogue-service', path: 'src/services/dialogue', responsibility: '对话通道+常驻+压缩触发' },
  { name: 'admin-service', path: 'src/services/admin', responsibility: '参数热改+穿透+权限+全自动化' },
  { name: 'seam', path: 'src/seam', responsibility: '接缝A：gateway+三通道+handshake' },
  { name: 'panel-api', path: 'src/panel-api', responsibility: '人侧命令面+反馈区' },
  { name: 'self-describe', path: 'src/self-describe', responsibility: '自述服务' },
  { name: 'git-asset', path: 'src/core/git-asset', responsibility: 'git文档资产操作工具' },
];

// 硬编码事件族 schema（9.3 七族子类型清单）
const EVENT_SCHEMAS: EventFamilySchema[] = [
  { family: 'organ', subtypes: ORGAN_SUBTYPES },
  { family: 'task', subtypes: TASK_SUBTYPES },
  { family: 'schedule', subtypes: SCHEDULE_SUBTYPES },
  { family: 'comm', subtypes: COMM_SUBTYPES },
  { family: 'dialogue', subtypes: DIALOGUE_SUBTYPES },
  { family: 'admin', subtypes: ADMIN_SUBTYPES },
  { family: 'doc', subtypes: DOC_SUBTYPES },
];

export function describeSystem(projStore: ProjectionsStore, eventStore: EventStore, configDir?: string): SystemSnapshot {
  // F6 补全：读工作流清单 + 参数当前值
  let workflows: WorkflowDescriptor[] = [];
  let workflowContents: Record<string, string> = {};
  let automations: any = null;
  let procedures: ProcedureDescriptor[] = [];
  let params: Record<string, any> = {};

  if (configDir) {
    // 读 assets/workflows/ 目录
    try {
      const wfDir = join(configDir, 'workflows');
      const files = readdirSync(wfDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.md'));
      workflows = files.map(f => ({ name: f.replace(/\.(ya?ml|md)$/, ''), file: join('workflows', f) }));
      // F.5：工作流文档内容（单文件失败忽略，不影响清单）
      for (const f of files) {
        try { workflowContents[f.replace(/\.(ya?ml|md)$/, '')] = readFileSync(join(wfDir, f), 'utf-8'); } catch { /* 单文件失败忽略 */ }
      }
    } catch { /* 目录不存在则空数组 */ }

    // F.5：automations.yaml 解析视图（解析失败 → null，查询面不抛）
    try { automations = yaml.parse(readFileSync(join(configDir, 'automations.yaml'), 'utf-8')); } catch { automations = null; }

    // F.5：procedures 工序模板清单（含解析内容，失败 → null）
    try {
      const pDir = join(configDir, 'procedures');
      procedures = readdirSync(pDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).map(f => {
        let template: any = null;
        try { template = yaml.parse(readFileSync(join(pDir, f), 'utf-8')); } catch { /* 保持 null */ }
        return { name: f.replace(/\.(ya?ml|md)$/, ''), file: join('procedures', f), template };
      });
    } catch { procedures = []; }

    // 读 params.yaml
    try {
      const raw = readFileSync(join(configDir, 'params.yaml'), 'utf-8');
      params = yaml.parse(raw) as Record<string, any>;
    } catch { /* 文件不存在则空对象 */ }
  }

  return {
    meta: { maxEventSeq: eventStore.getMaxSeq(), generatedAt: Date.now() },
    modules: MODULES,
    agents: projStore.all('SELECT * FROM agents ORDER BY agentId ASC'),
    workflows,
    workflowContents,
    automations,
    procedures,
    params,
    permissions: projStore.all('SELECT * FROM permission_rules ORDER BY rowid ASC'),
    eventSchemas: EVENT_SCHEMAS,
    tasks: projStore.all('SELECT * FROM tasks ORDER BY createdAt ASC'),
    taskNodes: projStore.all('SELECT * FROM task_nodes ORDER BY taskId ASC, nodeId ASC'),
    workspaces: projStore.all('SELECT * FROM workspaces ORDER BY workspaceId ASC'),
    loadQueue: projStore.all('SELECT * FROM load_queue ORDER BY priority DESC, createdAt ASC'),
    dialogues: projStore.all('SELECT * FROM dialogue_turns ORDER BY dialogueId ASC'),
    guidances: projStore.all('SELECT * FROM guidances ORDER BY createdAt ASC'),
    consults: projStore.all('SELECT * FROM consults ORDER BY createdAt ASC'),
    purposes: projStore.all('SELECT * FROM purposes ORDER BY purposeId ASC'),
    replayByPurpose: projStore.all('SELECT * FROM events_by_purpose ORDER BY purposeId ASC'),
    valueCompare: projStore.all('SELECT * FROM value_compare ORDER BY requestedAt ASC'),
    registry: projStore.all('SELECT * FROM registry ORDER BY seamId ASC'),
    agentRegistry: projStore.all('SELECT * FROM agent_registry ORDER BY agentId ASC'),
    permissionRules: projStore.all('SELECT * FROM permission_rules ORDER BY rowid ASC'),
  };
}
