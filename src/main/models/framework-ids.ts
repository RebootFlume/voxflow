/**
 * 框架层 / 运行时包键的字面量表 —— 全仓库唯一一份。
 *
 * 为什么单独成文件：这两个词表此前被抄了 5 遍（spec-data 的 ModelLayer、model-manager 的
 * FRAMEWORKS、runtime-download 的 RUNTIME_PACKAGES.framework、两个 registry 的字符串、
 * index.ts 的孤儿清理列表），改一处忘一处就是静默错位。
 * 现在所有派生都从这里出发，且加了编译期约束（见 runtime-packages.ts 的
 * `Record<RuntimeKey, …>`）—— 新增一层/一个包时漏写会直接编译失败。
 *
 * 本文件**不 import 任何东西**：它被 spec-data / model-manager / runtime-download 同时引用，
 * 任何依赖都可能引入循环。
 */

/**
 * 框架层 id —— 同时是磁盘目录层名与模型身份前缀（`<层>/<目录名>`）。
 *
 * 一个框架层 = 一个推理引擎 = 一套权重格式约定；同名模型可以出现在多个层里
 * （如 "Qwen3-ASR-0.6B" 同时有 llama.cpp 版与 audio.cpp 版），靠层区分。
 */
export const MODEL_LAYERS = ['llama.cpp', 'sherpa-onnx', 'audio.cpp'] as const
export type ModelLayer = (typeof MODEL_LAYERS)[number]

/**
 * 运行时包键 —— 下载 / 安装状态 / 「框架就绪」判定都用它，**与框架层不是一一对应**：
 * 一个引擎可以有多套运行时包（历史上 audio.cpp 就有 cpu / cuda 两个，现在合并成一个）。
 */
export const RUNTIME_KEYS = ['gguf', 'onnx', 'audiocpp'] as const
export type RuntimeKey = (typeof RUNTIME_KEYS)[number]

/**
 * sherpa-onnx 的模型族 —— C API 靠「路径放哪个子结构体」区分模型类型，没有名字嗅探。
 *
 * 定义在这里而不是 session-*.ts：族清单同时约束 spec 声明、C 结构体初始化、
 * NUMERIC_DEFAULTS 三处，放在零依赖模块里才能让依赖方向始终是「数据 → 实现」。
 */
export const SHERPA_ASR_FAMILIES = ['paraformer', 'sense_voice', 'transducer', 'nemo_ctc'] as const
export type SherpaAsrFamily = (typeof SHERPA_ASR_FAMILIES)[number]

export const SHERPA_TTS_FAMILIES = [
  'vits',
  'matcha',
  'kokoro',
  'kitten',
  'zipvoice',
  'pocket',
  'supertonic'
] as const
export type SherpaTtsFamily = (typeof SHERPA_TTS_FAMILIES)[number]
