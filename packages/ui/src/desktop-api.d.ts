import type { DesktopApi } from '@openagent/shared-types/index';

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}

export {};
