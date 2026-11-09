/**
 * TTS 参数面板的能力表 —— 「这个模型有哪些参数、以什么形态出现」的唯一判据。
 *
 * 为什么需要它：参数散落在两个页面（音色在合成页、音色描述在音色设置页、语言在合成页），
 * 每处都靠各自的 if 判断，新增模型时三处都得改一遍，容易漏。这里把目录从 spec 推导出来，
 * 页面只负责「按表渲染」，不再判断能力。
 *
 * 能力来源 = models.items 的 payload（spec-data.ts 的声明经 model-manager 归一化），
 * 所以新增模型只需在 spec 里声明，UI 自动跟随，不需要改这个文件。
 */

/** 可配置参数 */
export type TtsParamKey = "voice" | "language" | "instruct";

/**
 * 控件形态：
 * - `edit`：可编辑
 * - `badge`：只读徽标 —— 该模型没有这个自由度，但「为什么没有」本身有信息量
 *   （如「固定中文」「自动识别」），渲染成灰底文字而不是留白
 * - `hidden`：整个字段不存在（不支持 instruct 的模型不该出现一个灰 textarea，那是噪音）
 */
export type TtsParamKind = "edit" | "badge" | "hidden";

export interface TtsParamControl {
  key: TtsParamKey;
  kind: TtsParamKind;
  /** `badge` 形态的文案（i18n key）；`edit`/`hidden` 不用 */
  badgeKey?: string;
  /** 文案插值（如固定语言的语言码，由调用方用 langLabel 转成显示名） */
  badgeVars?: Record<string, string>;
}

/** 能力判据：只取 TtsPanel 真正会读的字段，避免把整个 ModelItemState 拖进这个模块 */
export interface TtsCapabilitySource {
  languages?: string[];
  language_mode?: "auto" | "fixed" | "select" | "cloning";
  voice_mode?: { type: "fixed" | "preset" | "clone" | "preset_and_clone" };
  supports_instruct?: boolean;
}

export type TtsParamControls = Record<TtsParamKey, TtsParamControl>;

const NEED_MODEL = { badgeKey: "tts.voice.needModel" } as const;

/**
 * 推导参数控件表。
 *
 * `info` 缺失（未选中模型 / 清单里找不到）时给「先加载模型」徽标而不是隐藏整块：
 * 用户需要知道这里本该有参数，只是还没加载。
 */
export function ttsParamControls(
  info: TtsCapabilitySource | null | undefined,
): TtsParamControls {
  if (!info) {
    return {
      voice: { key: "voice", kind: "badge", ...NEED_MODEL },
      language: { key: "language", kind: "badge", ...NEED_MODEL },
      instruct: { key: "instruct", kind: "hidden" },
    };
  }

  const voiceMode = info.voice_mode?.type;
  const langMode = info.language_mode;

  return {
    // fixed = 单音色模型：没有可切换项，只展示音色名（渲染方负责填名字）
    voice:
      voiceMode === "fixed"
        ? { key: "voice", kind: "badge", badgeKey: "tts.voice.fixedVoice" }
        : { key: "voice", kind: "edit" },

    // 四种语言模式都有对应形态，langMode 缺失（旧 payload）按「不显示」处理
    language:
      langMode === "select"
        ? { key: "language", kind: "edit" }
        : langMode === "auto"
          ? { key: "language", kind: "badge", badgeKey: "tts.languageAuto" }
          : langMode === "fixed"
            ? // 描述符没给语言码时退回不带插值的文案：否则界面上会出现「固定 」这种半截话
              info.languages?.[0]
              ? {
                  key: "language",
                  kind: "badge",
                  badgeKey: "tts.languageFixed",
                  badgeVars: { lang: info.languages[0] },
                }
              : { key: "language", kind: "badge", badgeKey: "tts.languageFixedUnknown" }
            : langMode === "cloning"
              ? { key: "language", kind: "badge", badgeKey: "tts.languageCloning" }
              : { key: "language", kind: "hidden" },

    // 只有明确声明支持的模型才有这个字段；其余模型完全不出现在面板上
    instruct:
      info.supports_instruct === true
        ? { key: "instruct", kind: "edit" }
        : { key: "instruct", kind: "hidden" },
  };
}
