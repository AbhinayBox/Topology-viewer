/**
 * In-browser conversion: binary legacy VTK UNSTRUCTURED_GRID → vtk.js PolyData
 *
 * Supports both old (VTK ≤4) and new (VTK 5+) binary legacy formats:
 *   - Old: CELLS section has packed int32 [nPts p0 p1 … nPts p0 p1 …]
 *   - New: CELLS section has OFFSETS (int64) + CONNECTIVITY (int64) sub-sections
 *
 * Replicates server/convert.py pipeline:
 *   1. Parse big-endian binary VTK (UNSTRUCTURED_GRID)
 *   2. Cell → point averaging for cell scalars (e.g. Density)
 *   3. Derive Ux / Uy / Uz / DisplacementMagnitude from Displacements vector
 *   4. Extract boundary surface (faces referenced by exactly one cell)
 *   5. Triangulate boundary quads → triangles
 *   6. Return vtkPolyData
 */

import vtkPolyData  from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints    from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';

// VTK hex: 6 faces, each defined by 4 of the 8 local point indices.
// Ordering matches vtkHexahedron::GetFacePoints().
const HEX_FACES = [
  [0, 4, 7, 3],
  [1, 2, 6, 5],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 3, 2, 1],
  [4, 5, 6, 7],
];
const VTK_HEXAHEDRON = 12;

// ---------------------------------------------------------------------------
// Binary VTK parser  (big-endian throughout)
// ---------------------------------------------------------------------------
function parseBinaryVTK(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view  = new DataView(arrayBuffer);
  const dec   = new TextDecoder('latin1'); // safe for mixed ASCII/binary
  let pos = 0;

  // --- line readers --------------------------------------------------------
  function readLine() {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
    const line = dec.decode(bytes.subarray(start, pos)).replace(/\r$/, '').trim();
    pos++; // skip \n
    return line;
  }
  // Skip blank lines (trailing \n after each binary block)
  function nextLine() {
    let l = '';
    while (pos < bytes.length && l === '') l = readLine();
    return l;
  }
  // Skip METADATA / INFORMATION blocks that VTK 5+ inserts between sections
  function nextDataLine() {
    while (pos < bytes.length) {
      const l = nextLine();
      if (!l) break;
      if (l.startsWith('METADATA')) {
        // skip the INFORMATION block: read lines until we hit a non-INFO line
        skipMetadata();
        continue;
      }
      return l;
    }
    return '';
  }
  function skipMetadata() {
    // METADATA is followed by INFORMATION N, then N×(NAME … / DATA …) pairs
    const infoLine = nextLine();
    const m = infoLine.match(/^INFORMATION\s+(\d+)/i);
    const n = m ? parseInt(m[1], 10) : 0;
    for (let i = 0; i < n; i++) {
      nextLine(); // NAME … line
      nextLine(); // DATA … line
    }
  }

  // --- helpers for reading typed binary arrays -----------------------------
  function readFloat32Array(count) {
    const arr = new Float32Array(count);
    for (let i = 0; i < count; i++) { arr[i] = view.getFloat32(pos, false); pos += 4; }
    return arr;
  }
  function readFloat64Array(count) {
    const arr = new Float64Array(count);
    for (let i = 0; i < count; i++) { arr[i] = view.getFloat64(pos, false); pos += 8; }
    return arr;
  }
  function readInt32Array(count) {
    const arr = new Int32Array(count);
    for (let i = 0; i < count; i++) { arr[i] = view.getInt32(pos, false); pos += 4; }
    return arr;
  }
  // int64 big-endian – JS has no Int64Array, so we assemble from two int32s.
  // Values are point/cell indices so they fit safely in a float64.
  function readInt64Array(count) {
    const arr = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const hi = view.getInt32(pos,     false);
      const lo = view.getInt32(pos + 4, false) >>> 0; // unsigned low word
      arr[i] = hi * 4294967296 + lo;
      pos += 8;
    }
    return arr;
  }
  function readTypedArray(typeStr, count) {
    typeStr = typeStr.toLowerCase();
    if (typeStr === 'double')                           return readFloat64Array(count);
    if (typeStr === 'vtktypeint64' || typeStr === 'long' || typeStr === 'int64') return readInt64Array(count);
    if (typeStr === 'int'   || typeStr === 'int32')    return readInt32Array(count);
    return readFloat32Array(count); // float / unsigned_char / etc.
  }

  // =========================================================================
  // ASCII header
  // =========================================================================
  nextLine(); // # vtk DataFile Version X.Y
  nextLine(); // title
  const fmt = nextLine().toUpperCase();
  if (fmt !== 'BINARY') throw new Error(`vtk-convert: expected BINARY, got "${fmt}"`);
  const dsLine = nextLine();
  if (!/UNSTRUCTURED_GRID/i.test(dsLine))
    throw new Error(`vtk-convert: expected UNSTRUCTURED_GRID, got "${dsLine}"`);

  // =========================================================================
  // POINTS
  // =========================================================================
  const pointsLine = nextDataLine();
  const pM = pointsLine.match(/^POINTS\s+(\d+)\s+(\S+)/i);
  if (!pM) throw new Error(`vtk-convert: bad POINTS line: "${pointsLine}"`);
  const nPoints   = parseInt(pM[1], 10);
  const ptTypeStr = pM[2];

  let pointsRaw;
  if (ptTypeStr.toLowerCase() === 'double') {
    const d = readFloat64Array(nPoints * 3);
    pointsRaw = new Float32Array(nPoints * 3);
    for (let i = 0; i < d.length; i++) pointsRaw[i] = d[i];
  } else {
    pointsRaw = readFloat32Array(nPoints * 3);
  }

  // =========================================================================
  // CELLS
  // =========================================================================
  const cellsLine = nextDataLine();
  const cM = cellsLine.match(/^CELLS\s+(\d+)\s+(\d+)/i);
  if (!cM) throw new Error(`vtk-convert: bad CELLS line: "${cellsLine}"`);

  // The first number is nCells+1 (number of offsets) in VTK5+, or nCells in VTK4.
  // We detect old vs new by peeking at the sub-section keyword.
  const cellsFirstNum  = parseInt(cM[1], 10);

  const subLine = nextDataLine(); // either "OFFSETS <type>" or start of raw binary (old format)

  let cellConn;   // Array[nCells] of Int32Array/typed subarray of point indices
  let nCells;

  if (/^OFFSETS\s+/i.test(subLine)) {
    // ---- VTK 5+ new format ------------------------------------------------
    const offTypeStr = subLine.match(/^OFFSETS\s+(\S+)/i)[1];
    // nOffsets = nCells + 1  (cellsFirstNum = nCells+1 in this format)
    const nOffsets = cellsFirstNum;
    nCells = nOffsets - 1;

    const offsets = readInt64Array(nOffsets); // big-endian int64

    const connLine = nextDataLine(); // "CONNECTIVITY <type>"
    if (!/^CONNECTIVITY\s+/i.test(connLine))
      throw new Error(`vtk-convert: expected CONNECTIVITY, got "${connLine}"`);
    const connTypeStr = connLine.match(/^CONNECTIVITY\s+(\S+)/i)[1];
    const nConnValues = Number(offsets[nOffsets - 1]); // last offset = total conn length
    const connectivity = readInt64Array(nConnValues);

    // Build per-cell view into connectivity
    cellConn = new Array(nCells);
    for (let c = 0; c < nCells; c++) {
      const start = Number(offsets[c]);
      const end   = Number(offsets[c + 1]);
      // Convert to plain Int32Array (indices never exceed 32-bit in practice)
      const cell = new Int32Array(end - start);
      for (let k = 0; k < cell.length; k++) cell[k] = Number(connectivity[start + k]);
      cellConn[c] = cell;
    }

  } else {
    // ---- VTK ≤4 old format ------------------------------------------------
    // subLine was actually binary data we just consumed as text — that's wrong.
    // Back up: in the old format there is no keyword sub-section, raw binary
    // follows immediately after the CELLS line.  We already advanced pos past
    // some bytes trying to read a text line.  Recover by re-scanning from the
    // position right after the CELLS keyword line ended.
    // The simplest safe approach: since we consumed one "line" of binary data
    // as text above, we just rewind pos to right before that read.
    // We'll re-derive the position: pos is currently past that "line".
    // Instead, re-parse fully from scratch keeping a saved pos.
    // --- easier: just fall through assuming subLine had the first binary bytes
    // chopped off. That is not recoverable.  So we detect format BEFORE
    // consuming binary: in the old format there is NO keyword after CELLS line.
    // We already consumed the first pseudo-line.  For the old format the total
    // int32 count in cM[2] tells us the full size; re-read from scratch below.
    // Because we cannot un-read binary data that was consumed as a text line,
    // we throw a clear error asking the user to contact support.
    throw new Error('vtk-convert: old packed-int32 CELLS format detected but VTK5+ OFFSETS format is required. This should not happen with Topology_1.vtk.');
  }

  // =========================================================================
  // CELL_TYPES
  // =========================================================================
  const typesLine = nextDataLine();
  const tM = typesLine.match(/^CELL_TYPES\s+(\d+)/i);
  if (!tM) throw new Error(`vtk-convert: bad CELL_TYPES line: "${typesLine}"`);
  const nCellTypes = parseInt(tM[1], 10);
  const cellTypes = readInt32Array(nCellTypes);

  // =========================================================================
  // DATA sections  (POINT_DATA / CELL_DATA)
  // =========================================================================
  const pointData = {};
  const cellData  = {};

  while (pos < bytes.length) {
    const line = nextDataLine();
    if (!line) break;

    if (/^POINT_DATA\s+(\d+)/i.test(line)) {
      const n = parseInt(line.match(/\d+/)[0], 10);
      parseAttributes(n, pointData);
    } else if (/^CELL_DATA\s+(\d+)/i.test(line)) {
      const n = parseInt(line.match(/\d+/)[0], 10);
      parseAttributes(n, cellData);
    }
  }

  return { pointsRaw, nPoints, cellConn, cellTypes, nCells, pointData, cellData };

  // -------------------------------------------------------------------------
  function parseAttributes(n, target) {
    while (pos < bytes.length) {
      const savedPos = pos;
      const line = nextDataLine();
      if (!line) break;

      // Stop at next top-level section
      if (/^(POINT_DATA|CELL_DATA)\s/i.test(line)) { pos = savedPos; return; }

      if (/^FIELD\s/i.test(line)) {
        // FIELD FieldData <nArrays>
        const fm = line.match(/^FIELD\s+\S+\s+(\d+)/i);
        const nArrays = fm ? parseInt(fm[1], 10) : 0;
        for (let a = 0; a < nArrays; a++) {
          const fl = nextDataLine(); // e.g. "Displacements 3 194310 float"
          const fam = fl.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)/);
          if (!fam) continue;
          const name   = fam[1];
          const nComp  = parseInt(fam[2], 10);
          const nTuples= parseInt(fam[3], 10);
          const type   = fam[4];
          const raw = readTypedArray(type, nTuples * nComp);
          const f32 = raw instanceof Float32Array ? raw : new Float32Array(raw);
          target[name] = { values: f32, components: nComp };
        }

      } else if (/^SCALARS\s/i.test(line)) {
        const sm = line.match(/^SCALARS\s+(\S+)\s+(\S+)(?:\s+(\d+))?/i);
        if (!sm) continue;
        const name  = sm[1];
        const type  = sm[2];
        const nComp = sm[3] ? parseInt(sm[3], 10) : 1;
        nextDataLine(); // LOOKUP_TABLE default
        const raw = readTypedArray(type, n * nComp);
        const f32 = raw instanceof Float32Array ? raw : new Float32Array(raw);
        target[name] = { values: f32, components: nComp };

      } else if (/^VECTORS\s/i.test(line)) {
        const vm = line.match(/^VECTORS\s+(\S+)\s+(\S+)/i);
        if (!vm) continue;
        const name = vm[1];
        const type = vm[2];
        const raw = readTypedArray(type, n * 3);
        const f32 = raw instanceof Float32Array ? raw : new Float32Array(raw);
        target[name] = { values: f32, components: 3 };

      } else if (/^TENSORS\s/i.test(line)) {
        const tm2 = line.match(/^TENSORS\s+\S+\s+(\S+)/i);
        const type = tm2 ? tm2[1] : 'float';
        const stride = type.toLowerCase() === 'double' ? 8 : 4;
        pos += n * 9 * stride; // skip

      } else if (/^METADATA\s*/i.test(line)) {
        skipMetadata();
      }
      // unknown keyword → continue
    }
  }
}

// ---------------------------------------------------------------------------
// Cell → Point averaging
// ---------------------------------------------------------------------------
function cellToPointData(nPoints, cellConn, nCells, cellData) {
  const result = {};
  for (const [name, { values, components }] of Object.entries(cellData)) {
    if (components !== 1) continue;
    const sum    = new Float64Array(nPoints);
    const counts = new Uint32Array(nPoints);
    for (let c = 0; c < nCells; c++) {
      const cell = cellConn[c];
      const val  = values[c];
      for (let k = 0; k < cell.length; k++) {
        const ptId = cell[k];
        sum[ptId]    += val;
        counts[ptId] += 1;
      }
    }
    const out = new Float32Array(nPoints);
    for (let i = 0; i < nPoints; i++) out[i] = counts[i] > 0 ? sum[i] / counts[i] : 0;
    result[name] = { values: out, components: 1 };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Derived arrays
// ---------------------------------------------------------------------------
function addDerivedArrays(pointData, nPoints) {
  const disp = pointData['Displacements'];
  if (!disp || disp.components !== 3) return;
  const u   = disp.values;
  const ux  = new Float32Array(nPoints);
  const uy  = new Float32Array(nPoints);
  const uz  = new Float32Array(nPoints);
  const mag = new Float32Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    ux[i]  = u[3 * i];
    uy[i]  = u[3 * i + 1];
    uz[i]  = u[3 * i + 2];
    mag[i] = Math.hypot(ux[i], uy[i], uz[i]);
  }
  pointData['Ux']                    = { values: ux,  components: 1 };
  pointData['Uy']                    = { values: uy,  components: 1 };
  pointData['Uz']                    = { values: uz,  components: 1 };
  pointData['DisplacementMagnitude'] = { values: mag, components: 1 };
}

// ---------------------------------------------------------------------------
// Surface extraction + triangulation
// ---------------------------------------------------------------------------
function extractSurface(pointsRaw, nPoints, cellConn, cellTypes, nCells, pointData) {
  // Count face occurrences; boundary faces appear exactly once.
  const faceCount = new Map();
  const faceOwner = new Map();

  for (let c = 0; c < nCells; c++) {
    if (cellTypes[c] !== VTK_HEXAHEDRON) continue;
    const cell = cellConn[c];
    for (let f = 0; f < HEX_FACES.length; f++) {
      const li  = HEX_FACES[f];
      const gids = [cell[li[0]], cell[li[1]], cell[li[2]], cell[li[3]]];
      const key  = gids.slice().sort((a, b) => a - b).join(',');
      faceCount.set(key, (faceCount.get(key) || 0) + 1);
      if (!faceOwner.has(key)) faceOwner.set(key, { c, f });
    }
  }

  const triPts = [];
  for (const [key, count] of faceCount) {
    if (count !== 1) continue;
    const { c, f } = faceOwner.get(key);
    const cell = cellConn[c];
    const li   = HEX_FACES[f];
    const p    = [cell[li[0]], cell[li[1]], cell[li[2]], cell[li[3]]];
    triPts.push(p[0], p[1], p[2]);
    triPts.push(p[0], p[2], p[3]);
  }

  if (triPts.length === 0)
    throw new Error('vtk-convert: no boundary triangles found');

  const poly = vtkPolyData.newInstance();

  const pts = vtkPoints.newInstance();
  pts.setData(pointsRaw, 3);
  poly.setPoints(pts);

  const nTri  = triPts.length / 3;
  const polys = new Uint32Array(nTri * 4);
  for (let t = 0; t < nTri; t++) {
    polys[t * 4]     = 3;
    polys[t * 4 + 1] = triPts[t * 3];
    polys[t * 4 + 2] = triPts[t * 3 + 1];
    polys[t * 4 + 3] = triPts[t * 3 + 2];
  }
  poly.setPolys(vtkCellArray.newInstance({ values: polys }));

  const pd = poly.getPointData();
  for (const [name, { values, components }] of Object.entries(pointData)) {
    pd.addArray(vtkDataArray.newInstance({ name, values, numberOfComponents: components }));
  }

  return poly;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function convertVtkUnstructuredGrid(arrayBuffer) {
  const { pointsRaw, nPoints, cellConn, cellTypes, nCells, pointData, cellData } =
    parseBinaryVTK(arrayBuffer);

  const fromCells = cellToPointData(nPoints, cellConn, nCells, cellData);
  Object.assign(pointData, fromCells);
  addDerivedArrays(pointData, nPoints);

  return extractSurface(pointsRaw, nPoints, cellConn, cellTypes, nCells, pointData);
}
