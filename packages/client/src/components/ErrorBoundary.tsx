import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * A thrown render used to leave the player looking at a blank black page with
 * no way back. Catching it costs nothing and turns the worst case into a
 * readable message plus a reload button.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[tetrisvs] render crashed:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="app scene-menu">
        <section className="room-screen">
          <div className="room-card">
            <div className="eyebrow">SOMETHING BROKE</div>
            <h2>CRASH</h2>
            <p className="disconnect-copy">{error.message || 'The interface hit an unexpected error.'}</p>
            <button className="primary-button" onClick={this.reset}>TRY AGAIN</button>
            <button className="text-button" onClick={() => window.location.reload()}>RELOAD</button>
          </div>
        </section>
      </main>
    );
  }
}
