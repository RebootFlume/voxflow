/**
 * 流式 WAV 写入器 —— 边合成边落盘，内存占用与文本长度**无关**。
 *
 * 为什么可以流式：WAV 头里只有两个字段依赖数据长度（偏移 4 的 RIFF size、
 * 偏移 40 的 data size），而文件支持任意位置写入。所以先写 44 字节占位头，
 * 每段 PCM 直接追加到文件尾，全部结束后 seek 回文件头把真实长度填上。
 * 播放器读的是最终值，不需要任何后处理。
 *
 * 为什么必须流式：把 PCM 全留在内存里等于同一份音频同时存在三份 ——
 * 分段数组、合并后的目标数组、写盘用的连续 Buffer，峰值 ≈ 音频总长的 3 倍。
 * 2MB 中文 TXT（约 70 万字）能解出 37 小时音频（6GB），峰值 18GB，必然 OOM。
 * 流式之后峰值只有「最后一段」那么大（120 字 ≈ 1.3MB），与文本长度无关。
 *
 * 代价：文件在合成开始时就存在了。中途失败/取消会留下一个**已回填长度的
 * 可播放文件**（而不是像以前那样什么都没有）—— 这个取舍是有意的：
 * 跑了 20 小时才失败，前 20 小时的音频扔掉才是浪费。
 */

import { open, unlink, type FileHandle } from 'node:fs/promises'

/** WAV 头固定 44 字节（PCM，无附加 chunk） */
export const WAV_HEADER_BYTES = 44

/**
 * data 段字节上限。
 *
 * RIFF 是 32 位长度字段：`dataBytes + 36` 必须装得下 0xFFFFFFFF。
 * 换算成时长（24kHz / 16bit / 单声道 = 48KB/s）约 4GB ≈ 24.9 小时。
 * 超过这个长度不是"慢"，而是**产出的文件本身不合法**，所以在写入时就拒绝，
 * 而不是等用户拿到一个播放器打不开的文件。
 */
export const MAX_WAV_DATA_BYTES = 0xffffffff - 36

/**
 * 构造 44 字节 PCM WAV 头。
 *
 * HTTP 流式响应传 `dataBytes = 0xFFFFFFFF`：data 段长度事前未知时，
 * 这是 WAV 事实上的"未知长度"约定（ffmpeg 等解码器按流式处理）。
 */
export function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  return fillWavHeader(Buffer.alloc(WAV_HEADER_BYTES), dataBytes, sampleRate)
}

/**
 * 把 WAV 头写进已有的 buffer 并返回它。
 *
 * 单独拆出来是为了让 WavStreamWriter 复用同一块 44 字节 buffer：
 * 每写完一段都要更新长度，每段都重新 alloc 一次纯属浪费。
 */
export function fillWavHeader(header: Buffer, dataBytes: number, sampleRate: number): Buffer {
  const sr = Math.max(sampleRate, 1)
  header.write('RIFF', 0, 'ascii')
  // 长度未知（0xFFFFFFFF）时不能算 `36 + dataBytes`：会溢出成 35，
  // 写出一个"总长 43 字节"的头，解码器直接判文件损坏。
  header.writeUInt32LE(dataBytes === 0xffffffff ? 0xffffffff : (36 + dataBytes) >>> 0, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sr, 24)
  header.writeUInt32LE(sr * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes >>> 0, 40)
  return header
}

/** 把整块 Buffer 写进文件句柄（`write` 允许短写，必须循环到写完） */
async function writeAll(fh: FileHandle, buf: Buffer, position?: number): Promise<void> {
  let offset = 0
  while (offset < buf.length) {
    const { bytesWritten } = await fh.write(
      buf,
      offset,
      buf.length - offset,
      position === undefined ? null : position + offset
    )
    if (bytesWritten <= 0) throw new Error('写盘中断（bytesWritten = 0）')
    offset += bytesWritten
  }
}

export class WavStreamWriter {
  private dataBytes = 0
  private sampleRate = 0
  /** 复用同一块头：每段都要更新长度，每段重新 alloc 纯属浪费 */
  private readonly header = Buffer.alloc(WAV_HEADER_BYTES)

  private constructor(
    private readonly fh: FileHandle,
    private readonly path: string
  ) {}

  /** 建文件并写占位头（长度为 0，待首次 `append` 与 `finalize` 回填） */
  static async create(path: string): Promise<WavStreamWriter> {
    const fh = await open(path, 'w')
    const writer = new WavStreamWriter(fh, path)
    await writeAll(fh, fillWavHeader(writer.header, 0, 0))
    return writer
  }

  /** 已写入的 PCM 字节数（不含 44 字节头） */
  get bytes(): number {
    return this.dataBytes
  }

  /**
   * 追加一段 PCM。
   *
   * 采样率在第一次 append 时确定；与之一致性由调用方保证（这里只做防御），
   * 因为"同一模型输出不同采样率"属于引擎故障，不是可以用参数修好的问题。
   */
  async append(samples: Int16Array, sampleRate: number): Promise<void> {
    if (this.sampleRate === 0) {
      this.sampleRate = sampleRate
    } else if (sampleRate !== this.sampleRate) {
      throw new Error(`采样率中途变化（${this.sampleRate} → ${sampleRate}），已中止以免拼出变速音频`)
    }

    const bytes = samples.byteLength
    if (this.dataBytes + bytes > MAX_WAV_DATA_BYTES) {
      const limitH = (MAX_WAV_DATA_BYTES / 2 / (sampleRate || 24000) / 3600).toFixed(1)
      const doneH = (this.dataBytes / 2 / (sampleRate || 24000) / 3600).toFixed(1)
      throw new Error(
        `音频已超过 WAV 格式上限（约 ${limitH} 小时，当前 ${doneH} 小时）。` +
          'WAV 头用 32 位长度字段，再长播放器就打不开了，请把文本拆成多次合成。'
      )
    }

    // 零拷贝：直接写 Int16Array 背后的内存，不逐样本 writeInt16LE
    // （逐样本是 N 次 JS 调用，长文本会把主线程占住数秒，表现为窗口无响应）
    const view = Buffer.from(samples.buffer, samples.byteOffset, bytes)
    await writeAll(this.fh, view)
    this.dataBytes += bytes

    // **先 PCM 后头**，顺序不能反：崩溃时头只能"少报"，不能"多报"。
    // 头说 0 字节但有数据 → 播放器当空文件，但文件里其实有东西；
    // 头说 N 字节但只有 M < N → 播放器读到末尾报错，比空文件更糟。
    //
    // 每段都回填（一次 44 字节 pwrite，相对每段 1.3MB 的音频可忽略），
    // 这样进程被强杀 / 窗口崩溃时，盘上那个文件到头来仍是**完整可播**的，
    // 不需要任何"崩溃恢复"机制 —— 文件本来就没坏过。
    // 数据在 OS page cache 里，进程被杀不会丢；只有整机断电才可能丢最后一段，
    // 那种情况下头会少报一段，仍然可播（不会多报）。
    await this.writeHeader()
  }

  /** 回填头（position=0，文件指针此刻在尾部，不指定会追加到屁股上） */
  private async writeHeader(): Promise<void> {
    fillWavHeader(this.header, this.dataBytes, this.sampleRate)
    await writeAll(this.fh, this.header, 0)
  }

  /** 回填最终长度并关闭。返回 PCM 字节数（0 表示一段都没写出来） */
  async finalize(): Promise<number> {
    // 最后一次 append 已经写过同样的头；这里再写一次是为了兜住
    // "一段都没产出"（头仍是 create 时的 0）和将来可能出现的其他退出路径。
    await this.writeHeader()
    await this.fh.close()
    return this.dataBytes
  }

  /** 关闭并删除（没写进任何音频时用，避免留下一个 44 字节的空 WAV） */
  async discard(): Promise<void> {
    await this.fh.close()
    await unlink(this.path).catch(() => {})
  }
}
