// P3：受控循环工厂。
import type { UlmControlledLoop, UlmRunHandle, UlmRunInput, UlmRunResult, UlmLoopPorts } from "../contracts.js";
import { ControlledRunHandle } from "./handle.js";

export function createControlledLoop(): UlmControlledLoop {
  return {
    async run(input: UlmRunInput, ports: UlmLoopPorts): Promise<UlmRunResult> {
      const handle = new ControlledRunHandle(input, ports, input.dialogueText);
      return handle.wait();
    },
    createHandle(input: UlmRunInput, ports: UlmLoopPorts): UlmRunHandle {
      return new ControlledRunHandle(input, ports, input.dialogueText);
    },
  };
}
