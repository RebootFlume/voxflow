/**
 * 进程内 FFI 引擎（llama.cpp C API）的统一出口。
 *
 * 这里是「谁在跑推理」的唯一装配点：host（进程管理）+ adapter（引擎语义），
 * 其余模块一律从本文件取，不再各自 new。
 */

export { LlamaFfiHost } from './host'
export { LlamaFfiAdapter } from './adapter'
export type { LlamaSnapshot } from './host'

import { LlamaFfiHost } from './host'
import { LlamaFfiAdapter } from './adapter'

/** 全局单例：worker 进程与模型状态只有一份 */
export const llamaEngine = new LlamaFfiHost()

/** 注册到 registry 的 gguf 引擎适配器 */
export const llamaFfiAdapter = new LlamaFfiAdapter(llamaEngine)
