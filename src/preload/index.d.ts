import type { VoxFlowAPI } from './api'

declare global {
  interface Window {
    voxflow: VoxFlowAPI
  }
}

export type { VoxFlowAPI, DialogOptions, DialogResult, WindowAction } from './api'
