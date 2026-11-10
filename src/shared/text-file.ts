/**
 * 纯文本文件读取（TTS 导入 TXT 用）。
 *
 * 核心难点只有一个：**中文 TXT 大多不是 UTF-8**。
 * Windows 记事本在很长一段时间里默认保存为 ANSI（简中环境 = GBK/GB18030），
 * 用 UTF-8 硬读会得到满屏 `�`。但反过来，现代文件又基本都是 UTF-8，
 * 先按 GB18030 读会把正常中文读成乱码（GB18030 是双字节编码，几乎不产生无效序列，
 * 所以「先试 GBK」是最糟糕的策略 —— 它几乎总能"成功"，只是内容全错）。
 *
 * 因此判定顺序固定为：
 *   1. UTF-8 BOM            → 确定 UTF-8，直接去掉 BOM
 *   2. UTF-16 BOM（LE/BE）  → 确定 UTF-16
 *   3. 无 BOM 且能严格解码 UTF-8 → UTF-8（现代文件的主力，也是唯一可靠信号：
 *      `fatal: true` 会在遇到非法字节序列时抛错，中文 GBK 文本几乎必然触发）
 *   4. 以上都不成立        → GB18030（简体中文 ANSI 的超集，同时覆盖 GBK / GB2312）
 *
 * 不引入 iconv-lite 之类的依赖：Electron 自带完整 ICU，`TextDecoder` 原生支持
 * `gb18030` / `utf-16le` / `utf-16be`。
 */

/** 导入单文件上限（字节）。超过直接拒绝，不静默截断 —— 截断会让用户以为合成漏了内容。 */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

/** 零宽字符：从 Word / 网页复制来的文本里很常见，会让 TTS 读出怪异停顿 */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g

export interface DecodedText {
  /** 已做规范化（BOM 去掉、换行统一为 \n、多余空行折叠） */
  text: string
  /** 实际采用的编码（展示给用户，便于排查乱码） */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
  /** 原始字节数 */
  bytes: number
  /** 原始字符数（规范化之前，用于"文件本来有多少字"的对比） */
  rawChars: number
}

/**
 * 按 BOM / UTF-8 严格性 / GB18030 兜底 解码文本。
 *
 * 传 `Uint8Array` 而不是路径：解码逻辑要能单测，且未来可能从非文件来源（剪贴板）进来。
 */
export function decodeTextFile(buf: Uint8Array): DecodedText {
  const bytes = buf.byteLength
  let encoding: DecodedText['encoding']
  let body = buf

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = 'utf-8'
    body = buf.subarray(3)
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le'
    body = buf.subarray(2)
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be'
    body = buf.subarray(2)
  } else {
    try {
      // fatal:true ⇒ 非法字节序列直接抛，不会静默替换成 U+FFFD。
      // 这是区分「真 UTF-8」与「GBK 恰好能被宽松 UTF-8 解出垃圾」的唯一可靠手段。
      const probe = new TextDecoder('utf-8', { fatal: true })
      const raw = probe.decode(body)
      const normalized = normalizeText(raw)
      return { text: normalized, encoding: 'utf-8', bytes, rawChars: raw.length }
    } catch {
      encoding = 'gb18030'
    }
  }

  const raw = new TextDecoder(encoding).decode(body)
  return { text: normalizeText(raw), encoding, bytes, rawChars: raw.length }
}

/**
 * 文本规范化 —— 只做「不影响语义」的清理，不碰措辞。
 *
 * - 去 BOM 与零宽字符（复制粘贴的常见残留）
 * - 换行统一为 \n（Windows TXT 是 \r\n）
 * - 3 个以上连续空行折成 2 个：空行在 TTS 里等于长停顿，
 *   一屏空行能听出好几秒静音，但保留 1 个空行作为段落分隔是合理的
 * - 行尾空白去掉（对 TTS 无意义，只会让分段切点落在奇怪位置）
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
