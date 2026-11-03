// WKWebView injects this optional bridge. The standalone browser has none.
interface Window {
  webkit?: {
    messageHandlers?: {
      native?: { postMessage(message: unknown): void };
    };
  };
}
