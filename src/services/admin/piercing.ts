import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { ControlChannel } from '../../seam/control-channel.js';

// 设计锚点 6.3：穿透指令通道闭环——每条指令落管理操作事件，内核回执也落事件（澄清8：异步）
// Phase 0 修复②：指令改经 ControlChannel.sendCommand 真实下发内核（piercingIssued 事件由
// sendCommand 统一落，含 commandId 审计关联）。此前只落事件不投递，且全库无实例化（死代码）。
export class PiercingCommands {
  private rules: PermissionRule[];
  private controlChannel: ControlChannel;

  constructor(deps: { rules: PermissionRule[]; controlChannel: ControlChannel }) {
    this.rules = deps.rules;
    this.controlChannel = deps.controlChannel;
  }

  private require(subject: string, agentId: string): void {
    const perm = checkPermission(this.rules, subject, 'admin:pushConfig', `agent:${agentId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
  }

  // 6.2#1 模型配置下发
  pushModelConfig(subject: string, agentId: string, config: any) {
    this.require(subject, agentId);
    return this.controlChannel.sendCommand(subject, agentId, 'modelConfig', { config });
  }

  // 6.2#2 白名单下发
  pushWhitelist(subject: string, agentId: string, whitelist: string[]) {
    this.require(subject, agentId);
    return this.controlChannel.sendCommand(subject, agentId, 'whitelist', { whitelist });
  }

  // 6.2#10 agent定义下发
  pushAgentDef(subject: string, agentId: string, def: any) {
    this.require(subject, agentId);
    return this.controlChannel.sendCommand(subject, agentId, 'agentDef', { def });
  }

  // 1.3 控制行为：中断/改序/重来/修正
  control(subject: string, agentId: string, action: 'interrupt' | 'reorder' | 'redo' | 'correct', payload?: any) {
    this.require(subject, agentId);
    return this.controlChannel.sendCommand(subject, agentId, action, payload ?? {});
  }
}
