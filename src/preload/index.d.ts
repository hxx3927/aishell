import type { AishellApi } from '../shared/api'

declare global {
  interface Window {
    aishell: AishellApi
  }
}

export {}
