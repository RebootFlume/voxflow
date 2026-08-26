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
  activeSubMenu: "hotkey",
  setActiveModule: (m) => set((s) => ({ activeModule: m, activeSubMenu: s.activeModule === m ? s.activeSubMenu : DEFAULT_SUB_MENUS[m][0] })),
  setActiveSubMenu: (sub) => set({ activeSubMenu: sub }),
});
