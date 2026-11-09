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
 * 引擎展示名 —— 前端徽章/分组/配色的键。
 *
 * 与框架层 id 是两套命名：层是身份（磁盘目录、复合键），引擎名是**给人看的短名**
 * （llama / sherpa / audiocpp），徽章配色表与分组都以它为键。
 *
 * 此前主进程（model-manager.EngineName）与前端（stores/types.EngineName）各写了一份，
 * 加新引擎漏改前端时 `tsc` 完全不报错，只是徽章默默变成灰色兜底 ——
 * 实测加 'probe' 到主进程后前端类型检查依然通过。搬到这份零依赖词表后，
 * 两端共用同一个联合类型，加引擎只改一处。
 */
export const ENGINE_NAMES = ['llama', 'sherpa', 'audiocpp'] as const
export type EngineName = (typeof ENGINE_NAMES)[number]

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
