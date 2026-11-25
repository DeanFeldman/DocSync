import { useEffect, useRef } from "react";

export function useDismissibleMenu() {
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function dismissOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest("dialog:modal")) return;
      const menu = menuRef.current;
      if (menu?.open && !event.composedPath().includes(menu)) menu.open = false;
    }

    function dismissOnEscape(event: KeyboardEvent) {
      const menu = menuRef.current;
      if (!menu?.open || event.key !== "Escape" || event.defaultPrevented) return;
      menu.open = false;
      event.preventDefault();
      menu.querySelector<HTMLElement>(":scope > summary")?.focus();
    }

    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, []);

  return menuRef;
}
