"""
Shared data helpers (used by convert.py *and* the ParaViewWeb server).

Why this exists
---------------
* vtk.js can only parse XML formats (.vtp/.vti/...) and *ASCII* legacy PolyData.
  The assignment file is a BINARY legacy UNSTRUCTURED_GRID, so it is converted
  once, offline, into a surface .vtp that the browser can load.
* The server returns small PolyData results (slice / clip / contour) to the
  browser as base64-encoded .vtp, so the same writer lives here.
"""
import base64
import os
import tempfile

from vtkmodules.util.numpy_support import numpy_to_vtk, vtk_to_numpy
from vtkmodules.vtkCommonCore import vtkFloatArray
from vtkmodules.vtkFiltersCore import vtkTriangleFilter
from vtkmodules.vtkFiltersGeometry import vtkDataSetSurfaceFilter
from vtkmodules.vtkIOXML import vtkXMLPolyDataWriter

try:  # vtkCellDataToPointData moved between modules across VTK versions
    from vtkmodules.vtkFiltersCore import vtkCellDataToPointData
except ImportError:  # pragma: no cover
    from vtkmodules.vtkFiltersGeneral import vtkCellDataToPointData

import numpy as np


def add_derived_arrays(ds):
    """Add scalar arrays the browser can colour by (vtk.js colours by *scalar* arrays).

    Displacements (vector)  ->  Ux, Uy, Uz, DisplacementMagnitude
    Works in place on any vtkDataSet that has a 3-component 'Displacements' point array.
    """
    pd = ds.GetPointData()
    arr = pd.GetArray("Displacements")
    if arr is None or arr.GetNumberOfComponents() != 3:
        return ds
    u = vtk_to_numpy(arr).astype(np.float32)
    for i, name in enumerate(("Ux", "Uy", "Uz")):
        a = numpy_to_vtk(np.ascontiguousarray(u[:, i]), deep=True)
        a.SetName(name)
        pd.AddArray(a)
    mag = numpy_to_vtk(np.linalg.norm(u, axis=1).astype(np.float32), deep=True)
    mag.SetName("DisplacementMagnitude")
    pd.AddArray(mag)
    return ds


def cell_to_point(ds):
    """Average cell arrays (e.g. Density) onto points so they can be smoothly shaded
    and contoured. Original cell arrays are kept (PassCellData on)."""
    f = vtkCellDataToPointData()
    f.SetInputData(ds)
    f.PassCellDataOn()
    f.Update()
    return f.GetOutput()


def extract_surface(ugrid):
    """Boundary skin of a volumetric mesh as triangles (only faces nobody shares)."""
    s = vtkDataSetSurfaceFilter()
    s.SetInputData(ugrid)
    s.PassThroughPointIdsOff()
    s.Update()
    t = vtkTriangleFilter()  # triangles => simple marching-triangles iso-lines in JS
    t.SetInputData(s.GetOutput())
    t.PassVertsOff()
    t.PassLinesOff()
    t.Update()
    return t.GetOutput()


def _to_float32(poly):
    """Shrink double arrays to float32 (halves the download)."""
    for data in (poly.GetPointData(), poly.GetCellData()):
        for i in range(data.GetNumberOfArrays()):
            a = data.GetArray(i)
            if a is not None and a.GetDataType() == 11:  # VTK_DOUBLE
                f = vtkFloatArray()
                f.DeepCopy(a)
                f.SetName(a.GetName())
                data.AddArray(f)
    return poly


def write_vtp_bytes(poly, compress=True):
    """Serialise PolyData to .vtp bytes (appended raw + zlib, the layout vtk.js reads)."""
    w = vtkXMLPolyDataWriter()
    w.SetInputData(poly)
    w.SetDataModeToAppended()
    w.EncodeAppendedDataOff()
    if not compress:
        w.SetCompressorTypeToNone()
    fd, path = tempfile.mkstemp(suffix=".vtp")
    os.close(fd)
    try:
        w.SetFileName(path)
        w.Write()
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.remove(path)


def poly_to_b64(poly):
    return base64.b64encode(write_vtp_bytes(_to_float32(poly))).decode("ascii")
