// P5：命令分发胶水。把 P5 的 onCommand 与 P4 的 handleCommand（返回 ack）接起来。
import type { UlmBasePort, UlmControlAck, UlmControlCommand } from "../contracts.js";

export function startCommandDispatch(
  base: UlmBasePort,
  handler: (cmd: UlmControlCommand) => Promise<UlmControlAck>,
): () => void {
  return base.onCommand((cmd) => {
    void (async () => {
      let ack: UlmControlAck;
      try {
        ack = await handler(cmd);
      } catch (err) {
        ack = {
          commandId: cmd.commandId,
          agentId: cmd.agentId,
          success: false,
          detail: String(err),
          ...(cmd.taskId !== undefined ? { taskId: cmd.taskId } : {}),
          ...(cmd.purposeId !== undefined ? { purposeId: cmd.purposeId } : {}),
        };
      }
      try {
        base.sendAck(ack);
      } catch (err) {
        // ack 发送失败（连接断开）只记录：基座控制指令是 fire-and-forget，无重发机制
        void err;
      }
    })();
  });
}
