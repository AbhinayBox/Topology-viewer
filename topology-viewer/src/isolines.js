// Iso-lines on a triangulated surface ("marching triangles").
//
// For every triangle and every iso-level L we look at the three edges; an edge is
// crossed when its end values lie on different sides of L. A triangle then has either
// 0 or 2 crossings -> one line segment. Levels are evenly spaced, so each triangle only
// visits the few levels between its min and max value (fast even for 150k triangles).
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';

/** Evenly spaced interior levels: lo + (k+1)*(hi-lo)/(n+1), k = 0..n-1 */
export function levelsFor(lo, hi, n) {
  return Array.from({ length: n }, (_, k) => lo + ((k + 1) * (hi - lo)) / (n + 1));
}

export function buildIsolines(poly, arrayName, lo, hi, n) {
  const arr = poly.getPointData().getArrayByName(arrayName);
  if (!arr || arr.getNumberOfComponents() !== 1 || hi <= lo) return null;
  const P = poly.getPoints().getData();
  const C = poly.getPolys().getData(); // [3,a,b,c, 3,a,b,c, ...]
  const S = arr.getData();
  const step = (hi - lo) / (n + 1);
  const out = [];

  for (let i = 0; i < C.length; i += C[i] + 1) {
    if (C[i] !== 3) continue; // triangles only (converter guarantees it)
    const a = C[i + 1], b = C[i + 2], c = C[i + 3];
    const sa = S[a], sb = S[b], sc = S[c];
    const tmin = Math.min(sa, sb, sc), tmax = Math.max(sa, sb, sc);
    const k0 = Math.max(0, Math.ceil((tmin - lo) / step) - 1);
    const k1 = Math.min(n - 1, Math.floor((tmax - lo) / step) - 1);
    for (let k = k0; k <= k1; k++) {
      const L = lo + (k + 1) * step;
      let m = 0, x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
      for (let e = 0; e < 3; e++) {
        const p = e === 0 ? a : e === 1 ? b : c;
        const q = e === 0 ? b : e === 1 ? c : a;
        const sp = S[p], sq = S[q];
        if (sp < L === sq < L) continue; // same side -> no crossing
        const t = (L - sp) / (sq - sp);
        const x = P[3 * p] + t * (P[3 * q] - P[3 * p]);
        const y = P[3 * p + 1] + t * (P[3 * q + 1] - P[3 * p + 1]);
        const z = P[3 * p + 2] + t * (P[3 * q + 2] - P[3 * p + 2]);
        if (m === 0) { x0 = x; y0 = y; z0 = z; } else { x1 = x; y1 = y; z1 = z; }
        m++;
      }
      if (m === 2) out.push(x0, y0, z0, x1, y1, z1);
    }
  }
  if (!out.length) return null;

  const nSeg = out.length / 6;
  const lines = new Uint32Array(nSeg * 3);
  for (let s = 0; s < nSeg; s++) { lines[3 * s] = 2; lines[3 * s + 1] = 2 * s; lines[3 * s + 2] = 2 * s + 1; }
  const pd = vtkPolyData.newInstance();
  pd.setPoints(vtkPoints.newInstance({ values: Float32Array.from(out), numberOfComponents: 3 }));
  pd.setLines(vtkCellArray.newInstance({ values: lines }));
  return pd;
}
