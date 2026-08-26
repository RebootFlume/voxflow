import { Mic, Volume2, Globe, History, Settings, PackageOpen, type LucideIcon } from "lucide-react";
import type { Module } from "@/stores";

// ---- Module Icons ----

export const MODULE_ICONS: Record<Module, LucideIcon> = {
  asr: Mic,
  tts: Volume2,
  api: Globe,
  history: History,
  models: PackageOpen,
  settings: Settings,
};

// ---- Heading keys (i18n keys for module titles) ----

export const HEADING_KEYS: Record<Module, string> = {
  asr: "heading.asr",
  tts: "heading.tts",
  api: "heading.api",
  history: "heading.history",
  models: "heading.models",
  settings: "heading.settings",
};

// ---- Sub-menu heading maps (i18n keys for sub-page titles) ----

export const MODELS_SUB_HEADING: Record<string, string> = {
  settings: "submenu.settings",
  asr: "submenu.asr",
  tts: "submenu.tts",
};

export const ASR_SUB_HEADING: Record<string, string> = {
  hotkey: "submenu.hotkey",
  model: "submenu.model",
  transcribe: "submenu.transcribe",
  status: "submenu.status",
};

export const TTS_SUB_HEADING: Record<string, string> = {
  "model-device": "submenu.model-device",
  "voice-settings": "submenu.voice-settings",
  synthesize: "submenu.synthesize",
};

// ---- Sub-menu label keys (for Sidebar) ----

export const SUB_MENU_LABEL_KEYS: Record<string, string> = {
  hotkey: "submenu.hotkey",
  model: "submenu.model",
  status: "submenu.status",
  service: "submenu.service",
  "endpoint-status": "submenu.endpoint-status",
  console: "submenu.console",
  records: "submenu.records",
  runtime: "submenu.runtime",
  settings: "submenu.settings",
  asr: "submenu.asr",
  tts: "submenu.tts",
  "voice-settings": "submenu.voice-settings",
  synthesize: "submenu.synthesize",
  "model-device": "submenu.model-device",
  transcribe: "submenu.transcribe",
  general: "submenu.general",
  appearance: "submenu.appearance",
  about: "submenu.about",
};

// ---- Sidebar title keys ----

export const MODULE_TITLE_KEYS: Record<Module, string> = {
  asr: "sidebar.asr",
  tts: "sidebar.tts",
  api: "sidebar.api",
  history: "sidebar.history",
  models: "sidebar.models",
  settings: "sidebar.settings",
};

// ---- Heading resolver ----

export function resolveHeading(
  activeModule: Module,
  activeSubMenu: string,
  locale: "zh" | "en",
  t: (locale: "zh" | "en", key: string) => string,
): string {
  if (activeModule === "models" && MODELS_SUB_HEADING[activeSubMenu]) {
    return t(locale, MODELS_SUB_HEADING[activeSubMenu]);
  }
  if (activeModule === "asr" && ASR_SUB_HEADING[activeSubMenu]) {
    return t(locale, ASR_SUB_HEADING[activeSubMenu]);
  }
  if (activeModule === "tts" && TTS_SUB_HEADING[activeSubMenu]) {
    return t(locale, TTS_SUB_HEADING[activeSubMenu]);
  }
  return t(locale, HEADING_KEYS[activeModule]);
}
