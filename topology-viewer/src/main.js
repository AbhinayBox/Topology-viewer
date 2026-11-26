// ============================================================================
//  Topology Viewer — vtk.js dashboard with ParaViewWeb (wslink) remote filters
// ============================================================================
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import './style.css';

import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkColorMaps from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction/ColorMaps';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkAxesActor from '@kitware/vtk.js/Rendering/Core/AxesActor';
import vtkCellPicker from '@kitware/vtk.js/Rendering/Core/CellPicker';
import vtkPlaneSource from '@kitware/vtk.js/Filters/Sources/PlaneSource';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import { Corners } from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget/Constants';
import vtkInteractorStyleManipulator from '@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator';
import vtkMouseCameraTrackballRotateManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator';
import vtkMouseCameraTrackballPanManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator';
import vtkMouseCameraTrackballZoomManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator';
import vtkMouseCameraTrackballZoomToMouseManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomToMouseManipulator';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkPolyDataReader from '@kitware/vtk.js/IO/Legacy/PolyDataReader';

import { buildIsolines } from './isolines';
import { RemoteClient, latestOnly } from './remote';
import { convertVtkUnstructuredGrid } from './vtk-convert';

const $ = (id) => document.getElementById(id);
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

// ----------------------------------------------------------------------------
// Application state
// ----------------------------------------------------------------------------
const state = {
  arrayName: 'DisplacementMagnitude',
  cmap: 'Cool to Warm',
  reverse: false,
  bands: false,
  nBands: 10,
  range: [0, 1],
  iso: { on: false, n: 10, color: '#101010', width: 1.5 },
  repr: 'surface',
  opacity: 1,
  baseMode: 'visible', // visible | ghost | hidden
  clip: { on: false, axis: 'x', pos: 50, flip: false },
  op: { kind: 'slice', axis: 'x', pos: 50, flip: false, array: 'DisplacementMagnitude', levels: 4, active: false },
  bounds: [0, 1, 0, 1, 0, 1],
};

// ----------------------------------------------------------------------------
// vtk.js scene: render window, camera interaction, lookup table
// ----------------------------------------------------------------------------
const grw = vtkGenericRenderWindow.newInstance({ background: [0.043, 0.055, 0.082] });
grw.setContainer($('render'));
const renderer = grw.getRenderer();
const renderWindow = grw.getRenderWindow();
const interactor = grw.getInteractor();
const glView = grw.getApiSpecificRenderWindow();
new ResizeObserver(() => { grw.resize(); renderWindow.render(); }).observe($('render'));

// Mouse mapping: left=rotate, shift+left / middle=pan, right / wheel=zoom
const style = vtkInteractorStyleManipulator.newInstance();
style.removeAllMouseManipulators();
style.addMouseManipulator(vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 }));
style.addMouseManipulator(vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1, shift: true }));
style.addMouseManipulator(vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 }));
style.addMouseManipulator(vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3 }));
style.addMouseManipulator(vtkMouseCameraTrackballZoomToMouseManipulator.newInstance({ scrollEnabled: true, dragEnabled: false }));
interactor.setInteractorStyle(style);

// orientation gizmo
const axesActor = vtkAxesActor.newInstance();
axesActor.setXAxisColor([235, 70, 70]); axesActor.setYAxisColor([90, 210, 90]); axesActor.setZAxisColor([70, 140, 255]); // X red, Y green, Z blue
const orient = vtkOrientationMarkerWidget.newInstance({ actor: axesActor, interactor });
orient.setEnabled(true);
orient.setViewportCorner(Corners.BOTTOM_RIGHT);
orient.setViewportSize(0.16);
orient.setMinPixelSize(90);
orient.setMaxPixelSize(220);

const lut = vtkColorTransferFunction.newInstance();

// ----------------------------------------------------------------------------
// Layers: "base" = the loaded mesh surface, "remote" = result returned by ParaView
// ----------------------------------------------------------------------------
function makeLayer(name) {
  const mapper = vtkMapper.newInstance({ interpolateScalarsBeforeMapping: true });
  mapper.setLookupTable(lut);
  mapper.setUseLookupTableScalarRange(true);
  mapper.setResolveCoincidentTopologyToPolygonOffset(); // push surface back so iso-lines win the depth test
  mapper.setResolveCoincidentTopologyPolygonOffsetParameters(1, 1);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setAmbient(0.25);
  actor.getProperty().setDiffuse(0.75);
  actor.getProperty().setSpecular(0.15);
  actor.getProperty().setSpecularPower(30);
  const isoMapper = vtkMapper.newInstance();
  isoMapper.setScalarVisibility(false);
  const isoActor = vtkActor.newInstance();
  isoActor.setMapper(isoMapper);
  isoActor.getProperty().setLighting(false);
  isoActor.setVisibility(false);
  isoActor.setPickable(false);
  renderer.addActor(actor);
  renderer.addActor(isoActor);
  return { name, poly: null, mapper, actor, isoMapper, isoActor };
}
const base = makeLayer('base');
base.actor.setVisibility(false); // hidden until data is loaded
const remoteLayer = makeLayer('remote');
remoteLayer.actor.setVisibility(false);
const layers = [base, remoteLayer];

// translucent preview of the slicing / clipping plane + probe marker
const planeSrc = vtkPlaneSource.newInstance();
const planeMapper = vtkMapper.newInstance(); planeMapper.setInputConnection(planeSrc.getOutputPort());
const planeActor = vtkActor.newInstance(); planeActor.setMapper(planeMapper);
planeActor.getProperty().setColor(0.28, 0.77, 1); planeActor.getProperty().setOpacity(0.07);
planeActor.getProperty().setLighting(false); planeActor.setPickable(false); planeActor.setVisibility(false);
renderer.addActor(planeActor);

const sphereSrc = vtkSphereSource.newInstance({ thetaResolution: 24, phiResolution: 24 });
const markerMapper = vtkMapper.newInstance(); markerMapper.setInputConnection(sphereSrc.getOutputPort());
const markerActor = vtkActor.newInstance(); markerActor.setMapper(markerMapper);
markerActor.getProperty().setColor(1, 0.71, 0.33); markerActor.setPickable(false); markerActor.setVisibility(false);
renderer.addActor(markerActor);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const fmt = (v) => {
  if (!isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
  return String(+v.toPrecision(5));
};
const fmtInt = (n) => n.toLocaleString('en-US');
function toast(msg, kind = 'err', ms = 6000) {
  const t = $('toast'); t.textContent = msg; t.className = kind === 'info' ? 'info' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) { $('loadingText').textContent = text || ''; $('loading').hidden = !text; }
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const render = () => renderWindow.render();
function scalarArrays(poly) {
  const pd = poly.getPointData(); const out = [];
  for (let i = 0; i < pd.getNumberOfArrays(); i++) { const a = pd.getArrayByIndex(i); if (a.getNumberOfComponents() === 1) out.push(a); }
  return out;
}
function arrayRange(name) {
  const a = base.poly && base.poly.getPointData().getArrayByName(name);
  if (!a) return null;
  const r = a.getRange(); return [r[0], r[1]];
}

// ----------------------------------------------------------------------------
// Color mapping (color map / bands / range / legend)
// ----------------------------------------------------------------------------
const PREFERRED_CMAPS = ['Cool to Warm', 'Viridis (matplotlib)', 'Plasma (matplotlib)', 'Inferno (matplotlib)', 'jet', 'rainbow',
  'Rainbow Desaturated', 'Blue to Red Rainbow', 'erdc_rainbow_bright', 'Cool to Warm (Extended)', 'erdc_divHi_purpleGreen', 'Black-Body Radiation', 'Grayscale', 'X Ray'];

function populateCmaps() {
  const names = PREFERRED_CMAPS.filter((n) => vtkColorMaps.getPresetByName(n));
  if (!names.includes(state.cmap)) state.cmap = names[0] || vtkColorMaps.rgbPresetNames[0];
  $('cmap').innerHTML = names.map((n) => `<option>${n}</option>`).join('');
  $('cmap').value = state.cmap;
}

function applyLut() {
  const preset = vtkColorMaps.getPresetByName(state.cmap);
  if (preset) {
    let p = preset;
    if (state.reverse) { // mirror control-point positions: x' = xmin + xmax - x
      const pts = preset.RGBPoints; const xs = []; for (let i = 0; i < pts.length; i += 4) xs.push(pts[i]);
      const s = Math.min(...xs) + Math.max(...xs); const rev = [];
      for (let i = pts.length - 4; i >= 0; i -= 4) rev.push(s - pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
      p = { ...preset, RGBPoints: rev };
    }
    lut.applyColorMap(p);
  }
  lut.setMappingRange(state.range[0], state.range[1]);
  lut.updateRange();
  lut.setDiscretize(state.bands);
  lut.setNumberOfValues(state.nBands);
  lut.modified();
}

function applyScalars() {
  for (const L of layers) {
    if (!L.poly) continue;
    const has = state.arrayName && L.poly.getPointData().getArrayByName(state.arrayName);
    L.mapper.setScalarVisibility(!!has);
    if (has) { L.mapper.setColorByArrayName(state.arrayName); L.mapper.setScalarModeToUsePointFieldData(); }
    else L.actor.getProperty().setColor(0.72, 0.78, 0.9);
  }
  applyLut(); drawLegend(); scheduleIso(); render();
}

function drawLegend() {
  $('legend').hidden = !$('legendOn').checked || !state.arrayName;
  $('legendTitle').textContent = state.arrayName || '';
  $('legendTitle').title = state.arrayName || '';
  const cv = $('legendCanvas'); const ctx = cv.getContext('2d'); const H = cv.height; const rgb = [0, 0, 0];
  const [lo, hi] = state.range;
  for (let y = 0; y < H; y++) {
    let t = 1 - y / (H - 1); // 1 at the top
    if (state.bands) { const k = Math.min(state.nBands - 1, Math.floor(t * state.nBands)); t = k / (state.nBands - 1); }
    lut.getColor(lo + t * (hi - lo), rgb);
    ctx.fillStyle = `rgb(${rgb[0] * 255 | 0},${rgb[1] * 255 | 0},${rgb[2] * 255 | 0})`;
    ctx.fillRect(0, y, cv.width, 1);
  }
  const ticks = $('legendTicks'); ticks.innerHTML = '';
  const n = 5;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1); const s = document.createElement('span');
    s.style.top = `${f * 100}%`; s.textContent = fmt(hi - f * (hi - lo)); ticks.appendChild(s);
  }
}

function setRange(lo, hi, updateInputs = true) {
  state.range = [lo, hi];
  if (updateInputs) { $('rangeMin').value = fmt(lo); $('rangeMax').value = fmt(hi); }
}

// ----------------------------------------------------------------------------
// Contour lines (iso-lines) overlay
// ----------------------------------------------------------------------------
let isoTimer = null;
function scheduleIso() { clearTimeout(isoTimer); isoTimer = setTimeout(updateIso, 40); }
function updateIso() {
  const [lo, hi] = state.range;
  for (const L of layers) {
    L.isoActor.setVisibility(false);
    if (!state.iso.on || !L.poly || !state.arrayName) continue;
    const lines = buildIsolines(L.poly, state.arrayName, lo, hi, state.iso.n);
    if (!lines) continue;
    L.isoMapper.setInputData(lines);
    const p = L.isoActor.getProperty(); p.setColor(...hexToRgb(state.iso.color)); p.setLineWidth(state.iso.width);
    L.isoActor.setVisibility(L.actor.getVisibility() && state.baseMode !== 'ghost' || (L === remoteLayer && L.actor.getVisibility()));
  }
  render();
}

// ----------------------------------------------------------------------------
// Appearance
// ----------------------------------------------------------------------------
function applyAppearance() {
  for (const L of layers) {
    const p = L.actor.getProperty();
    p.setEdgeVisibility(state.repr === 'edges');
    p.setEdgeColor(0.05, 0.06, 0.09);
    p.setRepresentation(state.repr === 'wire' ? 1 : state.repr === 'points' ? 0 : 2);
    p.setPointSize(2);
  }
  // base layer visibility depends on the "original" mode (ghost/hidden when a remote result is shown)
  const remoteShown = remoteLayer.actor.getVisibility();
  const mode = remoteShown ? state.baseMode : 'visible';
  base.actor.setVisibility(mode !== 'hidden' && !!base.poly);
  base.actor.getProperty().setOpacity(mode === 'ghost' ? 0.15 : state.opacity);
  remoteLayer.actor.getProperty().setOpacity(state.op.kind === 'contour' ? Math.min(0.85, state.opacity) : state.opacity);
  base.isoActor.setVisibility(base.isoActor.getVisibility() && mode === 'visible');
  render();
}

// ----------------------------------------------------------------------------
// Browser-side clip plane (GPU clipping planes on the mappers)
// ----------------------------------------------------------------------------
const clipPlane = vtkPlane.newInstance();
function posToWorld(axis, pct) {
  const i = AXIS_INDEX[axis]; const lo = state.bounds[2 * i], hi = state.bounds[2 * i + 1];
  return lo + (pct / 100) * (hi - lo);
}
function applyClip() {
  const { on, axis, pos, flip } = state.clip;
  const origin = [0, 0, 0].map((_, i) => (state.bounds[2 * i] + state.bounds[2 * i + 1]) / 2);
  origin[AXIS_INDEX[axis]] = posToWorld(axis, pos);
  clipPlane.setOrigin(origin);
  clipPlane.setNormal(AXES[axis].map((v) => (flip ? -v : v)));
  for (const L of layers) {
    for (const m of [L.mapper, L.isoMapper]) {
      m.removeAllClippingPlanes();
      if (on) m.addClippingPlane(clipPlane);
    }
  }
  $('clipPosVal').textContent = `${pos}%`;
  render();
}

// ----------------------------------------------------------------------------
// Camera
// ----------------------------------------------------------------------------
function resetCamera() { renderer.resetCamera(); render(); }
function setView(kind) {
  const b = state.bounds; const c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  const V = { iso: [[1, 0.75, 1.1], [0, 1, 0]], '+x': [[1, 0, 0], [0, 1, 0]], '-x': [[-1, 0, 0], [0, 1, 0]],
    '+y': [[0, 1, 0], [0, 0, -1]], '-y': [[0, -1, 0], [0, 0, 1]], '+z': [[0, 0, 1], [0, 1, 0]], '-z': [[0, 0, -1], [0, 1, 0]] }[kind];
  const cam = renderer.getActiveCamera();
  cam.setFocalPoint(...c); cam.setPosition(c[0] + V[0][0], c[1] + V[0][1], c[2] + V[0][2]); cam.setViewUp(...V[1]);
  renderer.resetCamera(); render();
}

// ----------------------------------------------------------------------------
// Loading data
// ----------------------------------------------------------------------------
function setBasePoly(poly, label) {
  base.poly = poly; base.mapper.setInputData(poly);
  state.bounds = poly.getBounds();
  $('empty-state').hidden = true; // hide the upload prompt once data is loaded
  const arrays = scalarArrays(poly);
  $('colorBy').innerHTML = `<option value="">(solid color)</option>` + arrays.map((a) => `<option>${a.getName()}</option>`).join('');
  $('opArray').innerHTML = arrays.map((a) => `<option>${a.getName()}</option>`).join('');
  const names = arrays.map((a) => a.getName());
  state.arrayName = names.includes('DisplacementMagnitude') ? 'DisplacementMagnitude' : names[0] || '';
  state.op.array = state.arrayName;
  $('colorBy').value = state.arrayName; $('opArray').value = state.arrayName;
  const r = arrayRange(state.arrayName) || [0, 1]; setRange(r[0], r[1]);

  const b = state.bounds; const dim = [b[1] - b[0], b[3] - b[2], b[5] - b[4]].map((v) => v.toFixed(1)).join(' × ');
  $('stats').innerHTML = [
    ['Source', label], ['Surface points', fmtInt(poly.getNumberOfPoints())], ['Surface triangles', fmtInt(poly.getPolys().getNumberOfCells())],
    ['Size (x·y·z)', dim], ['Scalar arrays', names.length],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const diag = Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
  sphereSrc.setRadius(diag * 0.008);
  markerActor.setVisibility(false);
  clearRemote(false);
  applyAppearance(); applyClip(); applyScalars(); setView('iso');
}

function parseVtp(buf) { const r = vtkXMLPolyDataReader.newInstance(); r.parseAsArrayBuffer(buf); return r.getOutputData(0); }

async function loadBuffer(buf, name) {
  busy(`Parsing ${name}…`);
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
  try {
    let poly;
    if (/\.vtp$/i.test(name)) poly = parseVtp(buf);
    else {
      const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(400, buf.byteLength)));
      if (/UNSTRUCTURED_GRID|STRUCTURED_POINTS|RECTILINEAR|STRUCTURED_GRID/.test(head)) {
        busy(`Converting ${name} (extracting surface…)`);
        await new Promise((r) => setTimeout(r, 30)); // let the busy label repaint
        poly = await convertVtkUnstructuredGrid(buf);
      } else {
        const r = vtkPolyDataReader.newInstance(); r.parseAsArrayBuffer(buf); poly = r.getOutputData(0);
      }
    }
    if (!poly || !poly.getPoints() || poly.getNumberOfPoints() === 0) throw new Error('No geometry found in the file.');
    if (poly.getPolys().getNumberOfCells() === 0) throw new Error('File has no polygons to render (expected surface PolyData).');
    setBasePoly(poly, name);
  } catch (e) { console.error(e); toast(e.message || String(e)); } finally { busy(''); }
}

// ----------------------------------------------------------------------------
// ParaViewWeb remote operations
// ----------------------------------------------------------------------------
function defaultWsUrl() {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (['5173', '4173', '5174', ''].includes(location.port)) return `${proto}//${location.hostname || 'localhost'}:1234/ws`;
  return `${proto}//${location.host}/ws`; // page served by the wslink server itself (--content dist)
}

const remote = new RemoteClient({
  onState(s, msg) {
    const chip = $('conn');
    chip.className = `chip ${s === 'online' ? 'on' : s === 'connecting' ? 'wait' : 'off'}`;
    chip.textContent = s === 'online' ? 'online' : s === 'connecting' ? 'connecting…' : 'offline';
    $('connectBtn').textContent = s === 'online' ? 'Disconnect' : 'Connect';
    $('opRun').disabled = s !== 'online'; $('opClear').disabled = s !== 'online';
    if (s === 'offline' && msg) $('opInfo').textContent = `Not connected (${msg}).`;
  },
});

async function connectRemote() {
  if (remote.online) { remote.disconnect(); remote.onState('offline', 'disconnected'); return; }
  try {
    await remote.connect($('wsUrl').value.trim());
    const info = await remote.call('viewer.info');
    $('opInfo').innerHTML = `Connected to <b>${info.backend}</b> · ${fmtInt(info.cells)} volume cells, ${fmtInt(info.points)} points. Pick an operation and press <b>Run on server</b>.`;
  } catch (e) {
    console.error(e);
    toast('Could not reach the ParaViewWeb server. Start it with:  pvpython server/pvweb_server.py --port 1234   (see README)');
    remote.onState('offline', 'is the server running?');
  }
}

function planeFor(op) {
  const i = AXIS_INDEX[op.axis]; const origin = [0, 0, 0].map((_, k) => (state.bounds[2 * k] + state.bounds[2 * k + 1]) / 2);
  origin[i] = posToWorld(op.axis, op.pos);
  return { origin, normal: AXES[op.axis] };
}

function updatePlanePreview() {
  const op = state.op;
  const show = op.active && op.kind !== 'contour' && remoteLayer.actor.getVisibility();
  planeActor.setVisibility(!!show);
  if (!show) return;
  const { origin } = planeFor(op); const b = state.bounds; const pad = 0.04;
  const e = (k) => (b[2 * k + 1] - b[2 * k]) * pad;
  const lo = [b[0] - e(0), b[2] - e(1), b[4] - e(2)]; const hi = [b[1] + e(0), b[3] + e(1), b[5] + e(2)];
  const i = AXIS_INDEX[op.axis]; const [j, k] = [0, 1, 2].filter((v) => v !== i);
  const o = [...lo]; o[i] = origin[i]; const p1 = [...lo]; p1[i] = origin[i]; p1[j] = hi[j]; const p2 = [...lo]; p2[i] = origin[i]; p2[k] = hi[k];
  planeSrc.setOrigin(o); planeSrc.setPoint1(p1); planeSrc.setPoint2(p2); planeSrc.modified();
}

const runOp = latestOnly(async (op) => {
  if (!remote.online) return;
  try {
    $('opInfo').textContent = `Running ${op.kind} on the server…`;
    let res;
    if (op.kind === 'slice') { const { origin, normal } = planeFor(op); res = await remote.runFilter('viewer.slice', [origin, normal]); }
    else if (op.kind === 'clip') { const { origin, normal } = planeFor(op); res = await remote.runFilter('viewer.clip', [origin, normal, !op.flip]); }
    else {
      const r = arrayRange(op.array) || state.range;
      const values = Array.from({ length: op.levels }, (_, k) => r[0] + ((k + 1) * (r[1] - r[0])) / (op.levels + 1));
      res = await remote.runFilter('viewer.contour', [op.array, values]);
    }
    showRemote(res.poly);
    const m = res.meta;
    $('opInfo').innerHTML = `<b>${op.kind}</b> done by <b>${m.backend}</b> in ${m.ms} ms · ${fmtInt(m.points)} points, ${fmtInt(m.cells)} triangles`;
  } catch (e) { console.error(e); $('opInfo').textContent = `Server error: ${e.message || e}`; toast(`Remote ${op.kind} failed: ${e.message || e}`); }
});

function showRemote(poly) {
  remoteLayer.poly = poly; remoteLayer.mapper.setInputData(poly);
  remoteLayer.actor.setVisibility(poly.getNumberOfPoints() > 0);
  applyAppearance(); applyScalars(); updatePlanePreview();
}

function clearRemote(rerender = true) {
  state.op.active = false; remoteLayer.poly = null; remoteLayer.actor.setVisibility(false); remoteLayer.isoActor.setVisibility(false);
  planeActor.setVisibility(false);
  if (rerender) { applyAppearance(); }
}

function triggerOp() { if (state.op.active && remote.online) { updatePlanePreview(); runOp({ ...state.op }); } }

// ----------------------------------------------------------------------------
// Probe (click to read values)
// ----------------------------------------------------------------------------
const picker = vtkCellPicker.newInstance(); picker.setTolerance(0.0005);
function bary(p, a, b, c) { // barycentric coordinates of p in triangle abc
  const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v2 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d00 = d(v0, v0), d01 = d(v0, v1), d11 = d(v1, v1), d20 = d(v2, v0), d21 = d(v2, v1);
  const den = d00 * d11 - d01 * d01 || 1; const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}
function doPick(clientX, clientY) {
  const el = $('render'); const rect = el.getBoundingClientRect(); const [W, H] = glView.getSize();
  const x = ((clientX - rect.left) * W) / rect.width, y = ((rect.bottom - clientY) * H) / rect.height;
  picker.pick([x, y, 0], renderer);
  const actor = picker.getActors()[0]; const L = layers.find((l) => l.actor === actor);
  if (!L || !L.poly) { markerActor.setVisibility(false); $('probe').textContent = 'Nothing under the cursor.'; render(); return; }
  const cid = picker.getCellId(); const C = L.poly.getPolys().getData(); const P = L.poly.getPoints().getData();
  const ids = [C[4 * cid + 1], C[4 * cid + 2], C[4 * cid + 3]]; const pos = picker.getPickPosition();
  const V = ids.map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]); const w = bary(pos, V[0], V[1], V[2]);
  let html = `<b>${L === base ? 'Original mesh' : 'Remote result'}</b><br>x ${pos.map((v) => fmt(v)).join(' · ')}<br>`;
  for (const a of scalarArrays(L.poly)) { const d = a.getData(); html += `${a.getName()}: <b>${fmt(w[0] * d[ids[0]] + w[1] * d[ids[1]] + w[2] * d[ids[2]])}</b><br>`; }
  $('probe').innerHTML = html;
  markerActor.setPosition(...pos); markerActor.setVisibility(true); render();
}
(() => {
  let down = null; const el = $('render');
  el.addEventListener('pointerdown', (e) => { down = e.button === 0 && !e.shiftKey ? [e.clientX, e.clientY] : null; });
  el.addEventListener('pointerup', (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) doPick(e.clientX, e.clientY); down = null; });
})();

// ----------------------------------------------------------------------------
// UI wiring
// ----------------------------------------------------------------------------
function seg(id, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    el.dataset.value = b.dataset.v; onChange(b.dataset.v);
  });
}

function wire() {
  populateCmaps();
  $('wsUrl').value = defaultWsUrl();

  $('file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) loadBuffer(await f.arrayBuffer(), f.name); e.target.value = ''; });
  $('emptyStateFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) loadBuffer(await f.arrayBuffer(), f.name); e.target.value = ''; });
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
  window.addEventListener('dragleave', () => document.body.classList.remove('drag'));
  window.addEventListener('drop', async (e) => { e.preventDefault(); document.body.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) loadBuffer(await f.arrayBuffer(), f.name); });

  // color map
  $('colorBy').addEventListener('change', (e) => { state.arrayName = e.target.value; const r = arrayRange(state.arrayName); if (r) setRange(r[0], r[1]); applyScalars(); });
  $('cmap').addEventListener('change', (e) => { state.cmap = e.target.value; applyScalars(); });
  $('reverse').addEventListener('change', (e) => { state.reverse = e.target.checked; applyScalars(); });
  $('bands').addEventListener('change', (e) => { state.bands = e.target.checked; applyScalars(); });
  $('bandCount').addEventListener('input', (e) => { state.nBands = Math.max(2, Math.min(64, +e.target.value || 10)); applyScalars(); });
  const onRange = () => { const lo = parseFloat($('rangeMin').value), hi = parseFloat($('rangeMax').value); if (isFinite(lo) && isFinite(hi) && hi > lo) { setRange(lo, hi, false); applyScalars(); } };
  $('rangeMin').addEventListener('change', onRange); $('rangeMax').addEventListener('change', onRange);
  $('rangeReset').addEventListener('click', () => { const r = arrayRange(state.arrayName); if (r) { setRange(r[0], r[1]); applyScalars(); } });

  // iso-lines
  $('isoOn').addEventListener('change', (e) => { state.iso.on = e.target.checked; updateIso(); });
  $('isoColor').addEventListener('input', (e) => { state.iso.color = e.target.value; updateIso(); });
  $('isoWidth').addEventListener('input', (e) => { state.iso.width = +e.target.value; updateIso(); });
  $('isoCount').addEventListener('input', (e) => { state.iso.n = +e.target.value; $('isoCountVal').textContent = e.target.value; scheduleIso(); });

  // appearance
  $('repr').addEventListener('change', (e) => { state.repr = e.target.value; applyAppearance(); });
  $('opacity').addEventListener('input', (e) => { state.opacity = +e.target.value; $('opacityVal').textContent = state.opacity.toFixed(2); applyAppearance(); });
  $('axesOn').addEventListener('change', (e) => { orient.setEnabled(e.target.checked); render(); });
  $('legendOn').addEventListener('change', drawLegend);

  // local clip
  $('clipOn').addEventListener('change', (e) => { state.clip.on = e.target.checked; applyClip(); });
  seg('clipAxis', (v) => { state.clip.axis = v; applyClip(); });
  $('clipFlip').addEventListener('change', (e) => { state.clip.flip = e.target.checked; applyClip(); });
  $('clipPos').addEventListener('input', (e) => { state.clip.pos = +e.target.value; applyClip(); });

  // remote
  $('connectBtn').addEventListener('click', connectRemote);
  seg('opSeg', (v) => {
    state.op.kind = v; $('opPlane').hidden = v === 'contour'; $('opContour').hidden = v !== 'contour';
    $('opFlipWrap').style.display = v === 'clip' ? '' : 'none';
    state.baseMode = v === 'clip' ? 'hidden' : 'ghost'; $('baseMode').value = state.baseMode;
    if (state.op.active) triggerOp();
  });
  $('opFlipWrap').style.display = 'none';
  seg('opAxis', (v) => { state.op.axis = v; triggerOp(); });
  $('opFlip').addEventListener('change', (e) => { state.op.flip = e.target.checked; triggerOp(); });
  $('opPos').addEventListener('input', (e) => { state.op.pos = +e.target.value; $('opPosVal').textContent = `${state.op.pos}%`; triggerOp(); });
  $('opArray').addEventListener('change', (e) => { state.op.array = e.target.value; triggerOp(); });
  $('opLevels').addEventListener('input', (e) => { state.op.levels = +e.target.value; $('opLevelsVal').textContent = e.target.value; triggerOp(); });
  $('opRun').addEventListener('click', () => { state.op.active = true; state.baseMode = state.op.kind === 'clip' ? 'hidden' : 'ghost'; $('baseMode').value = state.baseMode; runOp({ ...state.op }); });
  $('opClear').addEventListener('click', () => { clearRemote(); $('opInfo').textContent = 'Remote result cleared.'; });
  $('baseMode').addEventListener('change', (e) => { state.baseMode = e.target.value; applyAppearance(); scheduleIso(); });

  // camera / toolbar
  document.querySelectorAll('#toolbar [data-view]').forEach((b) => { b.addEventListener('click', () => setView(b.dataset.view)); if (b.dataset.view !== 'iso') b.title = `View from ${b.dataset.view[0] === '+' ? '+' : '−'}${b.dataset.view[1].toUpperCase()}`; });
  $('resetCam').addEventListener('click', resetCamera);
  $('shot').addEventListener('click', async () => {
    const p = glView.captureNextImage('image/png'); render(); const url = await p;
    const a = document.createElement('a'); a.href = url; a.download = 'topology-view.png'; a.click();
  });
}

wire();
// handy for debugging / tests from the browser console
window.__viewer = { state, base, remoteLayer, remote, renderer, renderWindow, runOp, connectRemote };
