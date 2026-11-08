/**
 * sherpa-onnx 进程内 FFI 引擎的装配入口。
 *
 * 上层（registry / 退出清理）只认这里导出的单例，不感知 worker / 绑定细节。
 */

import { SherpaFfiAdapter } from './adapter-asr'

/** onnx 框架的全局单例（注册表与退出清理共用） */
export const sherpaFfiAdapter = new SherpaFfiAdapter()

export { SherpaAsrHost, SherpaTtsHost } from './host'
export { SherpaFfiAdapter } from './adapter-asr'
