/**
 * GGUF 权重 → 显存预估（与「谁在推理」无关的纯计算）。
 *
 * 无论推理跑在子进程还是进程内，显存账目都一样：权重 + mmproj + KV cache + 固定开销。
 * 放在独立模块里，两个引擎路线共用同一份口径，不会各自漂移。
 */

import { readGgufKvGeometryCached, type GgufKvGeometry } from './vram'

export type { GgufKvGeometry }

/** f16 KV cache 字节数 = ctx × 2(K+V) × layers × kv_heads × head_dim × 2B */
export function kvBytesF16(g: GgufKvGeometry, ctx: number): number {
  return ctx * 2 * g.layers * g.kvHeads * g.headDim * 2
}

/**
 * 进程级固定开销（CUDA 上下文 + cuBLAS 工作区 + 计算缓冲），MiB。
 *
 * 实测口径：驱动真值 −（权重 + mmproj + KV）≈ 620 MiB，且在 ctx 8192/4096/2048 三档一致
 * （0.6B Q8 + Q8 mmproj，RTX 4070 Laptop，全层上 GPU）。模型越大计算缓冲会略增，
 * 故这是个略偏保守的常数——宁可低估误差，不虚报。
 */
export const GPU_FIXED_OVERHEAD_MB = 620

/** 显存预估（MiB）= 权重 + mmproj + KV + 固定开销；几何缺失时按权重+mmproj+固定开销（下界） */
export function estimateVramMb(
  weightsBytes: number,
  mmprojBytes: number,
  geom: GgufKvGeometry | null,
  ctx: number
): number {
  const kv = geom ? kvBytesF16(geom, ctx) : 0
  return Math.ceil((weightsBytes + mmprojBytes + kv) / (1024 * 1024)) + GPU_FIXED_OVERHEAD_MB
}

/**
 * 读取 GGUF 的 KV 几何（供加载时算显存预估）。
 *
 * 实现统一在 `inference/vram.ts`（成块读 + 跳过 tokenizer 大数组 + 结果缓存），
 * 这里只做转发，避免两份实现再次分叉。
 */
export function readGgufKvGeometry(path: string): GgufKvGeometry | null {
  return readGgufKvGeometryCached(path)
}
