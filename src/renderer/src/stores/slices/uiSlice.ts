import type { Module } from "../types";
import { DEFAULT_SUB_MENUS } from "./shared";

export interface UiSlice {
  activeModule: Module;
  activeSubMenu: string;
  setActiveModule: (m: Module) => void;
  setActiveSubMenu: (s: string) => void;
}

export const createUiSlice = (set: (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => void): UiSlice => ({
  activeModule: "asr",
  // 启动落在「模型与设备」（asr 子菜单第一项）：先确认设备/显存，再选模型、加载；
  // 与「从别的模块切回语音识别」时的落地页保持一致（那里也是取 DEFAULT_SUB_MENUS[m][0]）
  activeSubMenu: DEFAULT_SUB_MENUS.asr[0],
  setActiveModule: (m) => set((s) => ({ activeModule: m, activeSubMenu: s.activeModule === m ? s.activeSubMenu : DEFAULT_SUB_MENUS[m][0] })),
  setActiveSubMenu: (sub) => set({ activeSubMenu: sub }),
});
