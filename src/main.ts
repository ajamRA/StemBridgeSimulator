import './ui/styles.css';
import { Game } from './game/Game';

const app = document.querySelector<HTMLElement>('#app');
if (!app) {
  throw new Error('#app tidak dijumpai');
}

new Game(app);

console.info(
  '[StemBridge] Siap. Kapasiti: tegangan > mampatan. Uji dengan butang Uji.',
);
