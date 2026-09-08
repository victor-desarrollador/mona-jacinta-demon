import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="screen-center">
          <section className="empty-card">
            <p className="eyebrow">Error</p>
            <h1>No se pudo renderizar la pantalla</h1>
            <p>{this.state.error.message}</p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
