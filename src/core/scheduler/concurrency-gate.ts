// 设计锚点 3.3④：同时工作agent上限。上限从 params.yaml 读取（3.7 零魔法数）。

export class ConcurrencyGate {
  private maxWorking: number;
  private currentWorking: number = 0;

  constructor(maxWorking: number) {
    this.maxWorking = maxWorking;
  }

  canStart(_agentId: string): boolean {
    return this.currentWorking < this.maxWorking;
  }

  hasCapacity(): boolean {
    return this.currentWorking < this.maxWorking;
  }

  incrementWorking(): void {
    this.currentWorking++;
  }

  decrementWorking(): void {
    if (this.currentWorking > 0) this.currentWorking--;
  }

  setMax(max: number): void {
    this.maxWorking = max;
  }
}
