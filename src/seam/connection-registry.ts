// E.1 补完：连接注册表（agentId ↔ connId 双向绑定）
// 8.7 注册时绑定、断连时解绑；控制指令经 resolve(agentId) 定向投递
// 同 agentId 重复 register：覆盖旧绑定（决策3：重连语义，不做通知）

export class ConnectionRegistry {
  private bindings: Map<string, string> = new Map();    // agentId -> connId
  private connAgents: Map<string, string> = new Map();  // connId -> agentId

  // 绑定（重复绑定覆盖旧映射，双向清理旧 connId）
  bind(agentId: string, connId: string): void {
    const old = this.bindings.get(agentId);
    if (old !== undefined && old !== connId) this.connAgents.delete(old);
    this.bindings.set(agentId, connId);
    this.connAgents.set(connId, agentId);
  }

  // 按 agentId 解析当前连接，未绑定返回 null
  resolve(agentId: string): string | null {
    return this.bindings.get(agentId) ?? null;
  }

  // 按 connId 反查 agent，无绑定返回 null
  agentOf(connId: string): string | null {
    return this.connAgents.get(connId) ?? null;
  }

  // 断连清理；guard 防陈旧解绑误删新绑定（同 agent 已重连到新 conn 时不动新映射）
  unbindByConn(connId: string): void {
    const agentId = this.connAgents.get(connId);
    if (agentId === undefined) return;
    if (this.bindings.get(agentId) === connId) this.bindings.delete(agentId);
    this.connAgents.delete(connId);
  }
}
