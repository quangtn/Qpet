/// <reference types="vite/client" />

import type { QPetApi } from '@shared'

declare global {
  interface Window {
    qpet: QPetApi
  }
}

export {}

