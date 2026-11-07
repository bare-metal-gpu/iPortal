// Supported keyboard names. Text and chords share the native touch sender.
const special = {
  ArrowLeft: "LeftArrow",
  ArrowRight: "RightArrow",
  ArrowUp: "UpArrow",
  ArrowDown: "DownArrow",
  Backspace: "Delete",
  Delete: "ForwardDelete",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Escape",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};
/** @param {unknown} key */
export const validKeyboardKey = (key) =>
  typeof key === "string" &&
  (Object.hasOwn(special, key) ||
    (Array.from(key).length === 1 &&
      (key.codePointAt(0) ?? 0) >= 32 &&
      key.codePointAt(0) !== 127));
