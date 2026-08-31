import type { Module } from "../types";

export const DEFAULT_SUB_MENUS: Record<Module, string[]> = {
  asr: ["model", "hotkey", "transcribe"],
  tts: ["model-device", "voice-settings", "synthesize"],
  api: ["service", "endpoint-status", "console"],
  history: ["records", "runtime"],
  models: ["framework", "asr", "tts", "settings"],
  settings: ["general", "appearance", "about"],
};
