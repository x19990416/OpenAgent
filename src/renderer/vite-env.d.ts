/// <reference types="vite/client" />
import type { DesktopApi } from '@shared-types/index';

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}
