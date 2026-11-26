#!/usr/bin/env python3
"""
ParaViewWeb-style remote-processing server for the vtk.js dashboard.

                 wslink (WebSocket, same transport ParaViewWeb uses)
   browser  <--------------------------------------------------------->  this process
   vtk.js    viewer.slice / viewer.clip / viewer.contour  (RPC)           ParaView filters
   renders   <------ base64 .vtp (PolyData) ------------------------     run on FULL volume

Two interchangeable back-ends, same RPC API:
  * ParaView  : started with `pvpython`  -> uses paraview.simple (Slice, Clip, Contour)
  * VTK       : started with plain Python -> uses the equivalent VTK filters
                (handy for quick tests when ParaView is not installed)

Run (ParaView):   pvpython server/pvweb_server.py --data data/Topology_1.vtk --port 1234
Run (fallback):   python   server/pvweb_server.py --data data/Topology_1.vtk --port 1234
Add `--content dist` to also serve the built web app from the same port.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wslink import register as exportRpc  # noqa: E402
from wslink import server  # noqa: E402

from vtkmodules.vtkCommonCore import vtkDoubleArray  # noqa: E402,F401
from vtkmodules.vtkIOLegacy import vtkDataSetReader  # noqa: E402

import dataprep  # noqa: E402

try:
    from paraview import simple as pvs
    from paraview import servermanager as pvsm
    from paraview.web import protocols as pv_protocols
    from paraview.web import pv_wslink
    HAVE_PARAVIEW = True
except ImportError:
    HAVE_PARAVIEW = False
    from wslink.websocket import LinkProtocol as _LinkProtocol
    from wslink.websocket import ServerProtocol as _ServerProtocol

BaseProtocol = pv_protocols.ParaViewWebProtocol if HAVE_PARAVIEW else _LinkProtocol
BaseServer = pv_wslink.PVServerProtocol if HAVE_PARAVIEW else _ServerProtocol

DATA_FILE = None  # set from --data


# --------------------------------------------------------------------------- helpers
def _flatten(data):
    """Composite -> single dataset (ParaView readers can return multiblock)."""
    if data is not None and data.IsA("vtkCompositeDataSet"):
        from vtkmodules.vtkFiltersCore import vtkAppendFilter
        it = data.NewIterator()
        it.InitTraversal()
        app = vtkAppendFilter()
        while not it.IsDoneWithTraversal():
            app.AddInputData(data.GetDataSet(it))
            it.GoToNextItem()
        app.Update()
        return app.GetOutput()
    return data


def _to_surface_poly(ds):
    """Whatever a filter returned -> triangle PolyData the browser can draw."""
    ds = _flatten(ds)
    if ds.IsA("vtkPolyData"):
        from vtkmodules.vtkFiltersCore import vtkTriangleFilter
        t = vtkTriangleFilter()
        t.SetInputData(ds)
        t.Update()
        return t.GetOutput()
    return dataprep.extract_surface(ds)  # volume (e.g. clipped grid) -> its skin


# --------------------------------------------------------------------------- back-ends
class ParaViewBackend:
    """Filters executed by ParaView's own pipeline (paraview.simple)."""
    name = "ParaView"

    def __init__(self, path):
        self.reader = pvs.OpenDataFile(path)
        self.c2p = pvs.CellDatatoPointData(Input=self.reader)       # Density -> point data
        self.calc = pvs.Calculator(Input=self.c2p)                  # |Displacements|
        self.calc.Function = "mag(Displacements)"
        self.calc.ResultArrayName = "DisplacementMagnitude"
        self.calc.UpdatePipeline()
        self.slice = pvs.Slice(Input=self.calc)
        self.slice.SliceType = "Plane"
        self.clip = pvs.Clip(Input=self.calc)
        self.clip.ClipType = "Plane"
        self.clip.Scalars = ["POINTS", "DisplacementMagnitude"]
        self.contour = pvs.Contour(Input=self.calc)
        self.contour.ComputeScalars = 1
        self.contour.ComputeNormals = 0

    def _fetch(self, proxy):
        proxy.UpdatePipeline()
        return pvsm.Fetch(proxy)

    def source(self):
        return self._fetch(self.calc)

    def do_slice(self, origin, normal):
        self.slice.SliceType.Origin = list(origin)
        self.slice.SliceType.Normal = list(normal)
        return self._fetch(self.slice)

    def do_clip(self, origin, normal, invert):
        self.clip.ClipType.Origin = list(origin)
        self.clip.ClipType.Normal = list(normal)
        self.clip.Invert = 1 if invert else 0
        return self._fetch(self.clip)

    def do_contour(self, array, values):
        self.contour.ContourBy = ["POINTS", array]
        self.contour.Isosurfaces = [float(v) for v in values]
        return self._fetch(self.contour)


class VtkBackend:
    """Same operations with plain VTK filters (no ParaView needed)."""
    name = "VTK (fallback)"

    def __init__(self, path):
        r = vtkDataSetReader()
        r.SetFileName(path)
        r.ReadAllScalarsOn(); r.ReadAllVectorsOn(); r.ReadAllFieldsOn()
        r.Update()
        self.grid = dataprep.cell_to_point(r.GetOutput())
        dataprep.add_derived_arrays(self.grid)

    def source(self):
        return self.grid

    def do_slice(self, origin, normal):
        from vtkmodules.vtkCommonDataModel import vtkPlane
        from vtkmodules.vtkFiltersCore import vtkCutter
        p = vtkPlane(); p.SetOrigin(*origin); p.SetNormal(*normal)
        c = vtkCutter(); c.SetCutFunction(p); c.SetInputData(self.grid)
        c.GenerateTrianglesOn(); c.Update()
        return c.GetOutput()

    def do_clip(self, origin, normal, invert):
        from vtkmodules.vtkCommonDataModel import vtkPlane
        from vtkmodules.vtkFiltersGeneral import vtkClipDataSet
        p = vtkPlane(); p.SetOrigin(*origin); p.SetNormal(*normal)
        c = vtkClipDataSet(); c.SetClipFunction(p); c.SetInputData(self.grid)
        c.SetInsideOut(1 if invert else 0); c.Update()
        return c.GetOutput()

    def do_contour(self, array, values):
        from vtkmodules.vtkFiltersCore import vtkContourFilter
        self.grid.GetPointData().SetActiveScalars(array)
        c = vtkContourFilter(); c.SetInputData(self.grid)
        c.ComputeScalarsOn(); c.ComputeNormalsOff()
        for i, v in enumerate(values):
            c.SetValue(i, float(v))
        c.Update()
        return c.GetOutput()


# --------------------------------------------------------------------------- RPC protocol
class ViewerProtocol(BaseProtocol):
    """RPC surface called from the browser as `viewer.<method>`."""

    def __init__(self):
        super().__init__()
        self.backend = None

    def _be(self):
        if self.backend is None:  # lazy: loads on first request, keeps server start instant
            t = time.time()
            self.backend = (ParaViewBackend if HAVE_PARAVIEW else VtkBackend)(DATA_FILE)
            print(f"[viewer] loaded {DATA_FILE} with {self.backend.name} in {time.time()-t:.1f}s")
        return self.backend

    @staticmethod
    def _pack(ds, t0, backend):
        poly = _to_surface_poly(ds)
        dataprep.add_derived_arrays(poly)  # Ux/Uy/Uz/|U| on the result too
        return {
            "vtp": dataprep.poly_to_b64(poly),
            "points": poly.GetNumberOfPoints(),
            "cells": poly.GetNumberOfCells(),
            "ms": round((time.time() - t0) * 1000),
            "backend": backend.name,
        }

    @exportRpc("viewer.info")
    def info(self):
        be = self._be()
        ds = _flatten(be.source())
        arrays = []
        pd = ds.GetPointData()
        for i in range(pd.GetNumberOfArrays()):
            a = pd.GetArray(i)
            arrays.append({"name": a.GetName(), "components": a.GetNumberOfComponents(),
                           "range": list(a.GetRange(-1 if a.GetNumberOfComponents() > 1 else 0))})
        return {"backend": be.name, "file": os.path.basename(DATA_FILE),
                "points": ds.GetNumberOfPoints(), "cells": ds.GetNumberOfCells(),
                "bounds": list(ds.GetBounds()), "arrays": arrays}

    @exportRpc("viewer.slice")
    def slice(self, origin, normal):
        t0 = time.time(); be = self._be()
        return self._pack(be.do_slice(origin, normal), t0, be)

    @exportRpc("viewer.clip")
    def clip(self, origin, normal, invert=False):
        t0 = time.time(); be = self._be()
        return self._pack(be.do_clip(origin, normal, invert), t0, be)

    @exportRpc("viewer.contour")
    def contour(self, array, values):
        t0 = time.time(); be = self._be()
        return self._pack(be.do_contour(array, values), t0, be)


# --------------------------------------------------------------------------- server
class ViewerServer(BaseServer):
    authKey = "wslink-secret"

    @staticmethod
    def add_arguments(parser):
        parser.add_argument("--data", default="data/Topology_1.vtk",
                            help="legacy .vtk (or any ParaView-readable) file to serve")

    @staticmethod
    def configure(args):
        global DATA_FILE
        DATA_FILE = os.path.abspath(args.data)
        if not os.path.exists(DATA_FILE):
            sys.exit(f"data file not found: {DATA_FILE}")
        ViewerServer.authKey = args.authKey

    def initialize(self):
        proto = ViewerProtocol()
        if HAVE_PARAVIEW:
            self.registerVtkWebProtocol(proto)
        else:
            self.registerLinkProtocol(proto)
        self.updateSecret(ViewerServer.authKey)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="vtk.js + ParaViewWeb remote filter server")
    server.add_arguments(parser)
    ViewerServer.add_arguments(parser)
    args = parser.parse_args()
    ViewerServer.configure(args)
    print(f"[viewer] back-end: {'ParaView' if HAVE_PARAVIEW else 'plain VTK fallback'}  |  "
          f"ws://{args.host}:{args.port}/{args.ws}")
    server.start_webserver(options=args, protocol=ViewerServer)
