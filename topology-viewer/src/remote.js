// Thin client for the ParaViewWeb-style server (wslink = the WebSocket RPC layer of ParaViewWeb).
import WebsocketConnection from 'wslink/src/WebsocketConnection';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';

export function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export function vtpToPolyData(arrayBuffer) {
  const r = vtkXMLPolyDataReader.newInstance();
  r.parseAsArrayBuffer(arrayBuffer);
  return r.getOutputData(0);
}

export class RemoteClient {
  constructor({ onState }) {
    this.onState = onState; // ('offline' | 'connecting' | 'online', message)
    this.session = null;
    this.conn = null;
  }

  connect(url, secret = 'wslink-secret') {
    this.disconnect();
    this.onState('connecting', url);
    return new Promise((resolve, reject) => {
      const conn = WebsocketConnection.newInstance({ urls: url, secret });
      this.conn = conn;
      conn.onConnectionReady(() => {
        this.session = conn.getSession();
        this.onState('online', url);
        resolve();
      });
      conn.onConnectionError((_c, err) => {
        this.session = null;
        this.onState('offline', 'connection failed');
        reject(err || new Error('connection failed'));
      });
      conn.onConnectionClose(() => {
        this.session = null;
        this.onState('offline', 'connection closed');
      });
      conn.connect();
    });
  }

  disconnect() {
    if (this.conn) { try { this.conn.destroy(); } catch (e) { /* ignore */ } }
    this.conn = null; this.session = null;
  }

  get online() { return !!this.session; }

  call(method, args = []) {
    if (!this.session) return Promise.reject(new Error('not connected'));
    return this.session.call(method, args);
  }

  /** Run an RPC returning {vtp: base64, ...} and decode it into a vtkPolyData. */
  async runFilter(method, args) {
    const res = await this.call(method, args);
    const poly = vtpToPolyData(b64ToArrayBuffer(res.vtp));
    return { poly, meta: res };
  }
}

/** "Latest wins" throttle: while one request is in flight only the newest pending one is kept. */
export function latestOnly(fn) {
  let busy = false, pending = null;
  const run = async (args) => {
    if (busy) { pending = args; return; }
    busy = true;
    try { await fn(args); } finally {
      busy = false;
      if (pending) { const a = pending; pending = null; run(a); }
    }
  };
  return run;
}
