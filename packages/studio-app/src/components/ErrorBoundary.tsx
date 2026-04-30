import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureException } from "../lib/telemetry";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureException(error, {
      source: "react_error_boundary",
      component_stack: info.componentStack?.slice(0, 500) ?? "",
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2>Something went wrong.</h2>
          <p>Reload Studio to continue.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
