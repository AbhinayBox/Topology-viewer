#!/usr/bin/env python3
"""Convert the binary legacy .vtk unstructured grid into a browser-friendly surface .vtp.

    python server/convert.py data/Topology_1.vtk public/data/Topology_1.vtp
"""
import sys

from vtkmodules.vtkIOLegacy import vtkDataSetReader

from dataprep import (add_derived_arrays, cell_to_point, extract_surface, write_vtp_bytes,
                      _to_float32)


def main(src, dst):
    r = vtkDataSetReader()          # auto-detects the dataset type
    r.SetFileName(src)
    r.ReadAllScalarsOn(); r.ReadAllVectorsOn(); r.ReadAllFieldsOn()
    r.Update()
    grid = r.GetOutput()
    print(f"read  : {grid.GetClassName()}  points={grid.GetNumberOfPoints()}  cells={grid.GetNumberOfCells()}")
    grid = cell_to_point(grid)       # Density (cell) -> Density (point) too
    add_derived_arrays(grid)
    surf = extract_surface(grid)
    print(f"skin  : points={surf.GetNumberOfPoints()}  triangles={surf.GetNumberOfCells()}")
    data = write_vtp_bytes(_to_float32(surf))
    with open(dst, "wb") as f:
        f.write(data)
    print(f"wrote : {dst}  ({len(data)/1e6:.1f} MB)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
