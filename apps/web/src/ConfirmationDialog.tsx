import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface ConfirmationRequest {
  title: string;
  message: string;
  action: string;
  destructive?: boolean;
}

const ConfirmationContext = createContext<((request: ConfirmationRequest) => Promise<boolean>) | null>(null);

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("ConfirmationProvider is missing.");
  return confirm;
}

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirm = useCallback((next: ConfirmationRequest) => {
    if (resolveRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setRequest(next);
    });
  }, []);

  function finish(confirmed: boolean) {
    dialogRef.current?.close();
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }

  useLayoutEffect(() => {
    if (request && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [request]);

  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {request && (
        <dialog
          ref={dialogRef}
          className="workspace-confirmation"
          aria-labelledby="workspace-confirmation-title"
          aria-describedby="workspace-confirmation-message"
          onCancel={(event) => {
            event.preventDefault();
            finish(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              finish(false);
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) finish(false);
          }}
        >
          <div className="workspace-confirmation-content">
            <h2 id="workspace-confirmation-title">{request.title}</h2>
            <p id="workspace-confirmation-message">{request.message}</p>
            <div className="workspace-confirmation-actions">
              <button type="button" className="quiet-button" onClick={() => finish(false)}>Cancel</button>
              <button type="button" className={request.destructive ? "danger-button" : "primary-button"} onClick={() => finish(true)}>
                {request.action}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </ConfirmationContext.Provider>
  );
}
