export interface UIHandles {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  btnBina: HTMLButtonElement;
  btnUji: HTMLButtonElement;
  btnPadam: HTMLButtonElement;
  btnUndo: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  loadSlider: HTMLInputElement;
  loadVal: HTMLElement;
  resultPanel: HTMLElement;
}

export function mountUI(app: HTMLElement): UIHandles {
  app.innerHTML = `
    <header class="toolbar">
      <h1>Stem<span>Bridge</span> — Jambatan Lidi</h1>
      <div class="btn-group">
        <button type="button" id="btn-bina" class="active" title="Bina ahli">Bina</button>
        <button type="button" id="btn-uji" title="Uji struktur">Uji</button>
        <button type="button" id="btn-padam" title="Padam ahli">Padam</button>
        <button type="button" id="btn-undo" title="Undo">Undo</button>
        <button type="button" id="btn-reset" class="danger" title="Reset">Reset</button>
      </div>
      <div class="load-control">
        <label for="beban">Beban</label>
        <input type="range" id="beban" min="1" max="80" value="20" />
        <span class="val" id="beban-val">20</span>
        <span>Panjang lidi: 1–3 + pepenjuru</span>
      </div>
    </header>
    <canvas id="game-canvas"></canvas>
    <aside class="result-panel" id="result-panel">
      <div class="tip">Tip: Bentuk segi tiga supaya struktur stabil. Mampatan lebih lemah daripada tegangan.</div>
      <div class="status">Mod: <strong>Bina</strong> — klik dua nod (auto-cermin 3D). Seret kiri = orbit kamera.</div>
      <div class="legend">
        <span><i style="background:#43a047"></i>Rendah</span>
        <span><i style="background:#fdd835"></i>Sederhana</span>
        <span><i style="background:#fb8c00"></i>Tinggi</span>
        <span><i style="background:#e53935"></i>Hampir gagal</span>
        <span><i style="background:#7f0000"></i>Gagal (u≥1)</span>
      </div>
    </aside>
  `;

  return {
    root: app,
    canvas: app.querySelector('#game-canvas')!,
    btnBina: app.querySelector('#btn-bina')!,
    btnUji: app.querySelector('#btn-uji')!,
    btnPadam: app.querySelector('#btn-padam')!,
    btnUndo: app.querySelector('#btn-undo')!,
    btnReset: app.querySelector('#btn-reset')!,
    loadSlider: app.querySelector('#beban')!,
    loadVal: app.querySelector('#beban-val')!,
    resultPanel: app.querySelector('#result-panel')!,
  };
}

export function setActiveMode(ui: UIHandles, mode: 'bina' | 'uji' | 'padam'): void {
  ui.btnBina.classList.toggle('active', mode === 'bina');
  ui.btnUji.classList.toggle('active', mode === 'uji');
  ui.btnPadam.classList.toggle('active', mode === 'padam');
}

export function renderResultPanel(
  el: HTMLElement,
  opts: {
    tip: string;
    statusHtml: string;
    statusClass: 'ok' | 'warn' | 'bad' | '';
    meta?: string;
  },
): void {
  el.innerHTML = `
    <div class="tip">${opts.tip}</div>
    <div class="status ${opts.statusClass}">${opts.statusHtml}</div>
    ${opts.meta ? `<div class="meta">${opts.meta}</div>` : ''}
    <div class="legend">
      <span><i style="background:#43a047"></i>Rendah</span>
      <span><i style="background:#fdd835"></i>Sederhana</span>
      <span><i style="background:#fb8c00"></i>Tinggi</span>
      <span><i style="background:#e53935"></i>Hampir gagal</span>
      <span><i style="background:#7f0000"></i>Gagal (u≥1)</span>
    </div>
  `;
}
