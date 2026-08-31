// 设计锚点 3.1：单调递增 seq。纯函数，输入当前 max seq，输出下一个。
export function nextSeq(currentMaxSeq: number): number {
  return currentMaxSeq + 1;
}
