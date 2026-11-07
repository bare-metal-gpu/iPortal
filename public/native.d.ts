// WKWebView injects this optional bridge. The standalone browser has none.
import type { NativeMessage } from "../public-contracts.ts";
declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        native?: { postMessage(message: NativeMessage): void };
      };
    };
  }
}
