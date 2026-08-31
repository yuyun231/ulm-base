import type { EventBus } from '../core/event-bus/bus.js';
import type { ProjectionsStore } from '../core/projector/projections-store.js';
import type { PermissionRule } from '../core/permission/rule-loader.js';
import type { TransportLayer } from './transport.js';
import { EventChannel } from './event-channel.js';
import { ServiceChannel } from './service-channel.js';
import { ControlChannel, type ControlCommand } from './control-channel.js';
import { HandshakeChannel, type HandshakeConfig } from './handshake.js';
import { ConnectionRegistry } from './connection-registry.js';

// 设计锚点 8.1：gateway = 单 WebSocket 多路复用三通道 + 握手
// 装配三个 channel + handshake，按 channel 字段路由

export class SeamGateway {
  private eventChannel: EventChannel;
  private serviceChannel: ServiceChannel;
  private controlChannel: ControlChannel;
  private handshakeChannel: HandshakeChannel;
  private transport: TransportLayer;
  private registry: ConnectionRegistry;   // F.5：提升为字段（面板查询连接状态经 getConnectionRegistry）

  constructor(
    bus: EventBus,
    projStore: ProjectionsStore,
    rules: PermissionRule[],
    transport: TransportLayer,
    handshakeConfig: HandshakeConfig,
  ) {
    this.transport = transport;
    // E.1 多连接：共享连接注册表——handshake 注册绑定，control 定向投递
    const registry = new ConnectionRegistry();
    this.registry = registry;
    this.eventChannel = new EventChannel(bus, transport);
    this.serviceChannel = new ServiceChannel(bus, projStore, rules, transport);
    this.controlChannel = new ControlChannel(bus, transport, registry);
    this.handshakeChannel = new HandshakeChannel(bus, transport, handshakeConfig, registry, projStore);
  }

  start(): void {
    this.eventChannel.start();
    this.serviceChannel.start();
    this.controlChannel.start();
    this.handshakeChannel.start();
  }

  stop(): void {
    this.eventChannel.stop();
    this.serviceChannel.stop();
    this.controlChannel.stop();
    this.handshakeChannel.stop();
  }

  // 面板API/管理服务调用控制流
  sendControl(subject: string, agentId: string, command: ControlCommand, payload?: any): void {
    this.controlChannel.sendCommand(subject, agentId, command, payload);
  }

  // F1：暴露控制通道供调度器规则机使用（SchedulerRules 需经控制流下发 inject/correct）
  getControlChannel(): ControlChannel {
    return this.controlChannel;
  }

  // Phase 0 修复⑤：暴露握手通道（System 心跳轮询调 checkHeartbeatTimeout）
  getHandshakeChannel(): HandshakeChannel {
    return this.handshakeChannel;
  }

  // Phase F.5：暴露连接注册表（面板查询 agent 连接状态经 System 注入 PanelApi.resolveConn）
  getConnectionRegistry(): ConnectionRegistry {
    return this.registry;
  }

  getTransport(): TransportLayer {
    return this.transport;
  }
}
