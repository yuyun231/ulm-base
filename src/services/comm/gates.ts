// 设计锚点 5.5 硬闸：发起校验两条
// ①发起方持有该聚合任务的进行中子任务
// ②该聚合任务存在方案对话
// 首版校验逻辑内联在 consult.ts 的 initiateConsult 内；F1 补完时提取为独立 gate 模块
export class ConsultGates {
  // F1 补完：从投影查询进行中子任务 + 方案对话存在性
}
