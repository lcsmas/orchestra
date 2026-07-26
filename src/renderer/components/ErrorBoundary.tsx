import React from 'react';
import { scoped } from '../log';

const elog = scoped('react');

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Catches render/lifecycle exceptions anywhere below it.
 *
 * Without a boundary React unmounts the ENTIRE tree on any render throw, so a
 * single bad component produces a completely blank window — the least
 * diagnosable failure the app can have, and one that leaves no trace at all in a
 * packaged build where DevTools is closed. This does two things about that:
 *
 *  1. Writes the error AND the React component stack to the diagnostic log. The
 *     component stack is the part a plain `window.onerror` handler never gets,
 *     and it's what actually names the culprit component.
 *  2. Renders a readable fallback with the message, so the failure is visible
 *     and reportable instead of being an empty window.
 *
 * Deliberately NOT auto-recovering: silently re-rendering a component that just
 * threw tends to loop, and a visible error the user can screenshot is worth more
 * than a blank window that keeps retrying.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    elog.error(`render failed: ${error.message}`, {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  private reload = () => {
    window.location.reload();
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h1>Something broke in the UI</h1>
        <p className="error-boundary-msg">
          {error.name}: {error.message}
        </p>
        <p className="error-boundary-hint">
          The full stack has been written to the diagnostic log (Settings →
          Logs). Reloading is usually enough to recover.
        </p>
        {componentStack && (
          <details>
            <summary>Component stack</summary>
            <pre>{componentStack}</pre>
          </details>
        )}
        <button type="button" onClick={this.reload}>
          Reload
        </button>
      </div>
    );
  }
}
