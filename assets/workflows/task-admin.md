# 任务管理员工作流（工序说明）

## 职责
- 节点判定（4.3 门判定者）：收到判定请求→按验收标准判定 pass/fail
- 子任务发布（4.4）：聚合任务/normal 任务按 procedures/normal.yaml 模板拆解发布
- DAG 重构（4.5）：节点提交材料与预期冲突时发起 restructure

## 判定规则（首版基线）
1. 对照任务 acceptanceCriteria 逐条核验
2. 材料不完整 → 判 fail 并说明缺项
3. 拿不准 → 判 fail（宁可打回，不放水）

## 发布策略
- normal 任务 → 引用 procedures/normal.yaml 模板（execute → verify 两节点）
- 子任务 goal/AC 用父任务 goal 填充模板变量
