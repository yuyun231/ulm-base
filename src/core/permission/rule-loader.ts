import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';

// 设计锚点 6.5：权限规则表 = git 配置文档，3.6 校验点加载，热改生效。
// 加载只读文件，热改由 admin-service 触发（G8：基座调 git commit）后重新 load。

export interface PermissionRule {
  subject: string;    // 主体模式：human:* / agent:res-01 / module:scheduler
  action: string;     // 动作模式：task:create / admin:* / task:approve
  object: string;     // 对象模式：task:t1 / task:* / *
  decision: 'allow' | 'deny' | 'require-approval';
  ruleId?: string;    // Phase F.5：同步层身份追踪（面板热改按 ruleId UPSERT/DELETE）；yaml 落盘不带此字段
}

export class RuleLoader {
  load(filePath: string): PermissionRule[] {
    const text = fs.readFileSync(filePath, 'utf-8');
    const doc = parseYaml(text) as { rules?: PermissionRule[] };
    return doc.rules ?? [];
  }
}
