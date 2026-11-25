import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('UI error', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty-state">
        <h2>Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}</h2>
        <p className="muted">{this.state.error.message}</p>
        <p className="muted small-text">Your file on disk is unchanged.</p>
        <button className="primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
