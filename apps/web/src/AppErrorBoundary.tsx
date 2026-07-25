import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  message: string;
}

export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { message: "" };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      message:
        error instanceof Error
          ? error.message
          : "The desktop interface stopped unexpectedly.",
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("DocSync renderer error", error, info.componentStack);
  }

  render() {
    if (!this.state.message) return this.props.children;

    return (
      <main className="app-error-boundary">
        <section role="alert">
          <p className="eyebrow">Workspace recovery</p>
          <h1>DocSync needs to reload</h1>
          <p>
            Your original Word files and saved document versions are safe. Reload
            the local workspace to continue.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            Reload DocSync
          </button>
          <details>
            <summary>Technical details</summary>
            <code>{this.state.message}</code>
          </details>
        </section>
      </main>
    );
  }
}
