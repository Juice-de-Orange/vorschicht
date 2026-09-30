import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * One broken page instead of a white screen.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so until now any throw below the shell replaced the whole dashboard with an
 * empty document — no heading, no navigation, no way back, and nothing on
 * screen saying what happened. The concrete case that produced it was a
 * mistyped URL: `segmentAfter` called `decodeURIComponent` during render and
 * `/posteingang/%` raises `URIError`. That particular throw is fixed at its
 * source, but a boundary is not about one throw; it is the difference between
 * losing a page and losing the application, and there was none.
 *
 * Deliberately a class component: `componentDidCatch` has no hook equivalent,
 * and this is the one place in `apps/web` where the older API is the only API.
 *
 * The copy is German (§2), names the page that failed, and offers the way back
 * that still works. It reports the message rather than hiding it — this
 * dashboard has exactly one user, and a sentence he can quote is worth more
 * than a tidy apology.
 */
interface Props {
  /** Which page this guards, for the sentence. */
  bereich: string;
  children: ReactNode;
}

interface State {
  fehler: Error | null;
}

export class Fehlergrenze extends Component<Props, State> {
  override state: State = { fehler: null };

  static getDerivedStateFromError(fehler: Error): State {
    return { fehler };
  }

  override componentDidCatch(fehler: Error, info: ErrorInfo): void {
    // The console is the only place a stack survives; §18's structured logging
    // is server-side and this ran in a browser.
    console.error(`Fehler in ${this.props.bereich}`, fehler, info.componentStack);
  }

  /**
   * Reset when the guarded area changes.
   *
   * Without this a boundary latches: once `/posteingang/%` has thrown, every
   * later page renders the error instead of itself, and the only cure is a
   * reload — which on a single-page app reads as the whole dashboard being
   * broken rather than one link.
   */
  override componentDidUpdate(vorher: Props): void {
    if (vorher.bereich !== this.props.bereich && this.state.fehler !== null) {
      this.setState({ fehler: null });
    }
  }

  override render(): ReactNode {
    if (this.state.fehler === null) return this.props.children;
    return (
      <section className="karte">
        <h2>{this.props.bereich}</h2>
        {/*
          Gestaltet wie jeder andere Warnstreifen, und das ist kein Schmuck: eine
          rohe, ungestaltete Fehlerbox mitten in einem gestalteten Dashboard liest
          sich als „hier ist alles kaputt" statt als „diese eine Seite ist es" —
          also genau als das Gegenteil dessen, wofür diese Grenze existiert.
        */}
        <p data-testid="seiten-fehler" role="alert" className="streifen" data-ton="fehler">
          Diese Seite konnte nicht dargestellt werden: {this.state.fehler.message}. Der Rest des
          Dashboards funktioniert weiter — wähle oben einen anderen Bereich.
        </p>
      </section>
    );
  }
}
