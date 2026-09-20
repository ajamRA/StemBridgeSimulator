import HammerIcon from '@hugeicons/core-free-icons/HammerIcon';
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import UndoIcon from '@hugeicons/core-free-icons/UndoIcon';
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon';
import Layers01Icon from '@hugeicons/core-free-icons/Layers01Icon';
import LayoutLeftIcon from '@hugeicons/core-free-icons/LayoutLeftIcon';
import LayoutRightIcon from '@hugeicons/core-free-icons/LayoutRightIcon';
import BridgeIcon from '@hugeicons/core-free-icons/BridgeIcon';
import RulerIcon from '@hugeicons/core-free-icons/RulerIcon';
import StraightEdgeIcon from '@hugeicons/core-free-icons/StraightEdgeIcon';
import BendToolIcon from '@hugeicons/core-free-icons/BendToolIcon';
import WeightScaleIcon from '@hugeicons/core-free-icons/WeightScaleIcon';
import PlusSignIcon from '@hugeicons/core-free-icons/PlusSignIcon';
import EyeIcon from '@hugeicons/core-free-icons/EyeIcon';
import CubeIcon from '@hugeicons/core-free-icons/CubeIcon';
import MagicWand01Icon from '@hugeicons/core-free-icons/MagicWand01Icon';
import { BASE_RAIL_TARGET } from '../engine/constants';
import type { StickLengthPreset, StickShape, WallMode } from '../engine/types';
import { iconSvg, type IconSvgObject } from './icons';

export interface UIHandles {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  canvasWrap: HTMLElement;
  btnBina: HTMLButtonElement;
  btnUji: HTMLButtonElement;
  btnPadam: HTMLButtonElement;
  btnUndo: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  btnBase: HTMLButtonElement;
  /** Advanced: near/far mirror + transverse braces (default OFF). */
  chkMirror: HTMLInputElement;
  /** Show amplified lenturan after Uji (default ON). */
  chkLenturan: HTMLInputElement;
  baseCounter: HTMLElement;
  loadSlider: HTMLInputElement;
  loadVal: HTMLElement;
  resultPanel: HTMLElement;
  lengthButtons: HTMLButtonElement[];
  shapeButtons: HTMLButtonElement[];
  wallButtons: HTMLButtonElement[];
}

const hi = (icon: IconSvgObject, size = 18): string =>
  iconSvg(icon, { size, className: 'hi-icon' });

function primaryBtn(
  id: string,
  label: string,
  title: string,
  icon: IconSvgObject,
  extraClass = '',
): string {
  const cls = ['icon-btn', extraClass].filter(Boolean).join(' ');
  return `<button type="button" id="${id}" class="${cls}" title="${title}" aria-label="${title}">${hi(icon)}<span class="btn-label">${label}</span></button>`;
}

function segBtn(
  id: string,
  label: string,
  title: string,
  icon: IconSvgObject,
  dataAttr: string,
  dataVal: string,
  active = false,
): string {
  const cls = ['seg-btn', active ? 'active' : ''].filter(Boolean).join(' ');
  return `<button type="button" id="${id}" class="${cls}" data-${dataAttr}="${dataVal}" title="${title}" aria-label="${title}">${hi(icon, 16)}<span class="btn-label">${label}</span></button>`;
}

export function mountUI(app: HTMLElement): UIHandles {
  app.innerHTML = `
    <header class="topbar" role="banner">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${hi(BridgeIcon as IconSvgObject, 22)}</span>
        <h1>Stem<span>Bridge</span> <small>Jambatan Lidi</small></h1>
      </div>
      <div class="primary-actions btn-group" role="toolbar" aria-label="Tindakan utama">
        ${primaryBtn('btn-bina', 'Bina', 'Bina ahli', HammerIcon as IconSvgObject, 'active')}
        ${primaryBtn('btn-uji', 'Uji', 'Uji struktur', PlayIcon as IconSvgObject)}
        ${primaryBtn('btn-padam', 'Padam', 'Padam ahli', Delete02Icon as IconSvgObject)}
        ${primaryBtn('btn-undo', 'Undo', 'Undo', UndoIcon as IconSvgObject)}
        ${primaryBtn('btn-reset', 'Reset', 'Reset', RefreshIcon as IconSvgObject, 'danger')}
      </div>
    </header>

    <div class="workspace">
      <aside class="left-panel" aria-label="Edit fokus">
        <div class="panel-heading">
          <span class="panel-title">Edit fokus</span>
        </div>
        <div class="wall-picker edit-focus-picker seg-stack" role="group" aria-label="Edit fokus">
          ${segBtn('wall-lantai', 'Lantai', 'Lantai — deck 12×7 sahaja (sembunyi dinding)', Layers01Icon as IconSvgObject, 'wall', 'lantai', true)}
          ${segBtn('wall-kiri', 'Dinding kiri', 'Dinding kiri — lorong 1 sahaja', LayoutLeftIcon as IconSvgObject, 'wall', 'kiri')}
          ${segBtn('wall-kanan', 'Dinding kanan', 'Dinding kanan — lorong 7 sahaja', LayoutRightIcon as IconSvgObject, 'wall', 'kanan')}
          ${segBtn('wall-melintang', 'Melintang', 'Melintang: sambung Kiri↔Kanan merentas laluan', BridgeIcon as IconSvgObject, 'wall', 'melintang')}
        </div>
      </aside>

      <div class="stage">
        <div class="canvas-wrap">
          <canvas id="game-canvas" aria-label="Kanvas jambatan"></canvas>
        </div>

        <div class="tools-strip" role="toolbar" aria-label="Alat bina">
          <div class="tool-group length-picker" role="group" aria-label="Panjang lidi">
            <span class="tool-label">${hi(RulerIcon as IconSvgObject, 14)}<span>Panjang</span></span>
            <button type="button" id="len-1" data-length="1" class="chip-btn" title="Pendek — bracing / menegak" aria-label="Pendek">Pendek</button>
            <button type="button" id="len-2" data-length="2" class="chip-btn" title="Sederhana" aria-label="Sederhana">Sederhana</button>
            <button type="button" id="len-panjang" data-length="panjang" class="chip-btn active" title="Panjang — chord sehingga rentang penuh" aria-label="Panjang">Panjang</button>
            <button type="button" id="len-auto" data-length="auto" class="chip-btn chip-icon" title="Sebarang panjang antara nod" aria-label="Auto">${hi(MagicWand01Icon as IconSvgObject, 14)}<span>Auto</span></button>
          </div>

          <div class="tool-group shape-picker" role="group" aria-label="Bentuk lidi">
            <span class="tool-label">Bentuk</span>
            <button type="button" id="shape-lurus" data-shape="lurus" class="chip-btn chip-icon active" title="Lidi lurus (1 ahli)" aria-label="Lurus">${hi(StraightEdgeIcon as IconSvgObject, 14)}<span>Lurus</span></button>
            <button type="button" id="shape-lengkung" data-shape="lengkung" class="chip-btn chip-icon" title="Busur: nod puncak + 2 ahli axial" aria-label="Lengkung">${hi(BendToolIcon as IconSvgObject, 14)}<span>Lengkung</span></button>
          </div>

          <div class="tool-group load-group">
            <label class="tool-label" for="beban">${hi(WeightScaleIcon as IconSvgObject, 14)}<span>Beban</span></label>
            <input type="range" id="beban" min="1" max="80" value="20" aria-valuemin="1" aria-valuemax="80" aria-valuenow="20" />
            <span class="val" id="beban-val">20</span>
          </div>

          <div class="tool-group base-group">
            <button type="button" id="btn-base" class="icon-btn accent" title="Tambah 1 lidi panjang penuh pada lorong Z seterusnya (ulang hingga 7)" aria-label="Tambah Base">${hi(PlusSignIcon as IconSvgObject)}<span class="btn-label">+ Base</span></button>
            <span class="base-counter" id="base-counter" title="Sasaran cabaran bilik darjah">Base: 0/${BASE_RAIL_TARGET}</span>
          </div>

          <div class="tool-group toggle-group">
            <label class="adv-toggle" title="Selepas Uji, lidi nampak melentur (anjakan nod digandakan). Matikan untuk warna tegasan sahaja.">
              <input type="checkbox" id="chk-lenturan" checked />
              ${hi(EyeIcon as IconSvgObject, 14)}
              <span>Tunjuk lenturan</span>
            </label>
            <label class="adv-toggle" title="Lanjutan: salin setiap lidi ke kedua-dua dinding luar + brace melintang. Lalai MATI.">
              <input type="checkbox" id="chk-mirror" />
              ${hi(CubeIcon as IconSvgObject, 14)}
              <span>Cermin 3D</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <aside class="result-panel" id="result-panel" aria-live="polite">
      <div class="result-card">
        <div class="tip">Uji: lidi melentur; patah nampak putus dulu, bukan hilang terus.</div>
        <div class="status">Mod: <strong>Bina</strong> — tarik = 1 lidi; klik dua nod = sambung; <strong>+ Base</strong> = 1 lidi penuh / lorong Z.</div>
        <div class="legend">
          <span><i style="background:#43a047"></i>Rendah</span>
          <span><i style="background:#fdd835"></i>Sederhana</span>
          <span><i style="background:#fb8c00"></i>Tinggi</span>
          <span><i style="background:#e53935"></i>Hampir gagal</span>
          <span><i style="background:#7f0000"></i>Gagal (u≥1)</span>
        </div>
      </div>
    </aside>
  `;

  return {
    root: app,
    canvas: app.querySelector('#game-canvas')!,
    canvasWrap: app.querySelector('.canvas-wrap')!,
    btnBina: app.querySelector('#btn-bina')!,
    btnUji: app.querySelector('#btn-uji')!,
    btnPadam: app.querySelector('#btn-padam')!,
    btnUndo: app.querySelector('#btn-undo')!,
    btnReset: app.querySelector('#btn-reset')!,
    btnBase: app.querySelector('#btn-base')!,
    chkMirror: app.querySelector('#chk-mirror')!,
    chkLenturan: app.querySelector('#chk-lenturan')!,
    baseCounter: app.querySelector('#base-counter')!,
    loadSlider: app.querySelector('#beban')!,
    loadVal: app.querySelector('#beban-val')!,
    resultPanel: app.querySelector('#result-panel')!,
    lengthButtons: Array.from(app.querySelectorAll('.length-picker button')),
    shapeButtons: Array.from(app.querySelectorAll('.shape-picker button')),
    wallButtons: Array.from(app.querySelectorAll('.wall-picker button')),
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

export function setActiveWall(ui: UIHandles, mode: WallMode): void {
  for (const btn of ui.wallButtons) {
    btn.classList.toggle('active', btn.dataset.wall === mode);
  }
}

export function setBaseCounter(ui: UIHandles, count: number): void {
  ui.baseCounter.textContent = `Base: ${count}/${BASE_RAIL_TARGET}`;
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
    <div class="result-card">
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
    </div>
  `;
}
