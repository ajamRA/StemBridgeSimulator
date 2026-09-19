import type { StickLengthPreset } from '../engine/model';
import type { StickShape } from '../engine/types';

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
  lengthButtons: HTMLButtonElement[];
  shapeButtons: HTMLButtonElement[];
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
        <div class="length-picker" role="group" aria-label="Panjang lidi">
          <span class="length-label">Lidi:</span>
          <button type="button" id="len-1" data-length="1" title="1 unit — sokongan / bracing">Pendek</button>
          <button type="button" id="len-2" data-length="2" title="2 unit">Sederhana</button>
          <button type="button" id="len-3" data-length="3" class="active" title="3 unit — base / chords">Panjang</button>
          <button type="button" id="len-auto" data-length="auto" title="Sebarang 1–3 / pepenjuru">Auto</button>
        </div>
        <div class="shape-picker" role="group" aria-label="Bentuk lidi">
          <span class="length-label">Bentuk:</span>
          <button type="button" id="shape-lurus" data-shape="lurus" class="active" title="Lidi lurus (1 ahli)">Lurus</button>
          <button type="button" id="shape-lengkung" data-shape="lengkung" title="Busur: nod puncak + 2 ahli axial">Lengkung</button>
        </div>
      </div>
    </header>
    <canvas id="game-canvas"></canvas>
    <aside class="result-panel" id="result-panel">
      <div class="tip">Tip: Base: pilih Panjang. Sokongan: pilih Pendek. Lengkung sesuai untuk busur/arch di bahagian atas atau geladak.</div>
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
    lengthButtons: Array.from(app.querySelectorAll('.length-picker button')),
    shapeButtons: Array.from(app.querySelectorAll('.shape-picker button')),
  };
}

export function setActiveMode(ui: UIHandles, mode: 'bina' | 'uji' | 'padam'): void {
  ui.btnBina.classList.toggle('active', mode === 'bina');
  ui.btnUji.classList.toggle('active', mode === 'uji');
  ui.btnPadam.classList.toggle('active', mode === 'padam');
}

export function setActiveLength(ui: UIHandles, length: StickLengthPreset): void {
  for (const btn of ui.lengthButtons) {
    const v = btn.dataset.length;
    const active = length === 'auto' ? v === 'auto' : v === String(length);
    btn.classList.toggle('active', active);
  }
}

export function setActiveShape(ui: UIHandles, shape: StickShape): void {
  for (const btn of ui.shapeButtons) {
    btn.classList.toggle('active', btn.dataset.shape === shape);
  }
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
