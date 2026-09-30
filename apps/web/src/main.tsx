import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/index.css';

const container = document.getElementById('app');
if (!container) throw new Error('#app fehlt im Dokument');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/*
 * §17s Offline-Hülle anmelden.
 *
 * Drei Entscheidungen, jede mit ihrem Preis:
 *
 * **Nach `load`, nicht sofort.** Die Anmeldung lädt `sw.js`, und der Worker
 * lädt beim Installieren die Hülle samt ihrer Teile nach. Vor `load` wäre das
 * Bandbreite, die mit der ersten Anzeige konkurriert — gegen §22s Zusage „cold
 * load der Übersicht unter 2 s", die heute ohnehin nicht gehalten wird
 * (`docs/leistungsbudget.md`, §4).
 *
 * **Kein `catch`, das schweigt.** Eine Anmeldung schlägt aus Gründen fehl, die
 * nichts mit dieser Anwendung zu tun haben: kein sicherer Ursprung, privates
 * Fenster, eine Richtlinie im Browser. Keiner davon darf die Seite anhalten —
 * aber ein stiller Fehlschlag hiesse, dass „installierbar" und „nicht
 * installierbar" von aussen gleich aussehen, und genau diese Verwechslung ist
 * die, für die es dieses Projekt teuer geworden ist. Also eine Zeile in der
 * Konsole, auf Deutsch, mit dem Fehler daran.
 *
 * **Kein `updatefound`-Hinweis auf der Seite.** Ein Banner „neue Fassung
 * verfügbar" wäre die übliche Ergänzung und hier überflüssig: `sw.js` bedient
 * die Hülle netzwerkzuerst, ein Rollout ist also schon beim nächsten Aufruf da,
 * und ein Banner, das zum Neuladen auffordert, was ohnehin geschehen ist,
 * erzieht dazu, Banner wegzuklicken.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((fehler: unknown) => {
      console.warn('Der Service Worker konnte nicht angemeldet werden', fehler);
    });
  });
}
