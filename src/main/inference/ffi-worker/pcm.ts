/**
 * 进程边界上的 PCM 采样校验。
 *
 * IPC 序列化方式一变（比如退回 JSON），Float32Array 会变成普通对象；
 * 与其让下游拿到 NaN 再炸，不如在入口就明确拒绝或还原。
 */

/**
 * 把传进来的采样统一成 Float32Array。
 *
 * - Float32Array：原样返回（零拷贝）
 * - 普通数组：逐项转成 Float32Array
 * - 其它 TypedArray：按数值逐项转换
 */
export function toFloat32Array(input: unknown): Float32Array {
  if (input instanceof Float32Array) return input
  if (Array.isArray(input)) return Float32Array.from(input as number[])
  if (ArrayBuffer.isView(input) && 'length' in input) {
    return Float32Array.from(input as unknown as ArrayLike<number>)
  }
  throw new Error('请求里的音频采样格式不正确')
}
