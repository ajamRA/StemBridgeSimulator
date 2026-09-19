import { BASE_RAIL_TARGET } from '../engine/constants';
import type { StickLengthPreset } from '../engine/types';
import type { StickShape } from '../engine/types';

export interface UIHandles {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  btnBina: HTMLButtonElement;
  btnUji: HTMLButtonElement;
  btnPadam: HTMLButtonElement;
  btnUndo: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  btnBase: HTMLButtonElement;
  /** Advanced: near/far mirror + transverse braces (default OFF). */
  chkMirror: HTMLInputElement;
  baseCounter: HTMLElement;
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
        <button type="button" id="btn-base" class="accent" title="Tambah 1 lidi panjang merentangi span pada lorong seterusnya">+ Base (lidi panjang)</button>
      </div>
      <div class="load-control">
        <span class="base-counter" id="base-counter" title="Sasaran cabaran bilik darjah">Base panjang: 0/${BASE_RAIL_TARGET}</span>
        <label for="beban">Beban</label>
        <input type="range" id="beban" min="1" max="80" value="20" />
        <span class="val" id="beban-val">20</span>
        <div class="length-picker" role="group" aria-label="Panjang lidi">
          <span class="length-label">Lidi:</span>
          <button type="button" id="len-1" data-length="1" title="Pendek — bracing / menegak">Pendek</button>
          <button type="button" id="len-2" data-length="2" title="Sederhana">Sederhana</button>
          <button type="button" id="len-panjang" data-length="panjang" class="active" title="Panjang — chord sehingga rentang penuh">Panjang</button>
          <button type="button" id="len-auto" data-length="auto" title="Sebarang panjang antara nod">Auto</button>
        </div>
        <div class="shape-picker" role="group" aria-label="Bentuk lidi">
          <span class="length-label">Bentuk:</span>
          <button type="button" id="shape-lurus" data-shape="lurus" class="active" title="Lidi lurus (1 ahli)">Lurus</button>
          <button type="button" id="shape-lengkung" data-shape="lengkung" title="Busur: nod puncak + 2 ahli axial">Lengkung</button>
        </div>
        <label class="adv-toggle" title="Lanjutan: salin setiap lidi ke muka near+far dan tambah brace melintang (nampak kotak). Lalai MATI.">
          <input type="checkbox" id="chk-mirror" />
          <span>Cermin 3D (lanjutan)</span>
        </label>
      </div>
    </header>
    <canvas id="game-canvas"></canvas>
    <aside class="result-panel" id="result-panel">
      <div class="tip">Tarik untuk letak satu lidi. Tiada kotak automatik.</div>
      <div class="status">Mod: <strong>Bina</strong> — tarik = 1 lidi; klik dua nod = sambung; <strong>+ Base</strong> = 1 lidi penuh pada lorong Z seterusnya.</div>
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
    btnBase: app.querySelector('#btn-base')!,
    chkMirror: app.querySelector('#chk-mirror')!,
    baseCounter: app.querySelector('#base-counter')!,
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
    const active =
      length === 'auto'
        ? v === 'auto'
        : length === 'panjang'
          ? v === 'panjang'
          : v === String(length);
    btn.classList.toggle('active', active);
  }
}

export function setActiveShape(ui: UIHandles, shape: StickShape): void {
  for (const btn of ui.shapeButtons) {
    btn.classList.toggle('active', btn.dataset.shape === shape);
  }
}

export function setBaseCounter(ui: UIHandles, count: number): void {
  ui.baseCounter.textContent = `Base panjang: ${count}/${BASE_RAIL_TARGET}`;
  ui.baseCounter.classList.toggle('done', count >= BASE_RAIL_TARGET);
  ui.btnBase.disabled = count >= BASE_RAIL_TARGET;
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
