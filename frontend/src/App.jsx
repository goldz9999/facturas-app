import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import UploadFacturas from './UploadFacturas';
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
const PAGE_SIZE = 10;


function formatCosto(costo) {
  const n = Number(costo);
  if (Number.isNaN(n)) return costo ?? '-';
  return n.toLocaleString('es-PE', { style: 'currency', currency: 'PEN' });
}

export default function App() {
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [empresa, setEmpresa] = useState('');
  const [nFactura, setNFactura] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [modalImage, setModalImage] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (empresa) params.set('empresa', empresa);
      if (nFactura) params.set('n_factura', nFactura);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));

      const res = await fetch(`${API_URL}/facturas?${params.toString()}`);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const json = await res.json();
      setData(json.data || []);
      setTotal(json.total || 0);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || 'Error desconocido');
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [empresa, nFactura, desde, hasta, page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Realtime: refresca solo cuando hay un cambio real en la tabla
  useEffect(() => {
    const channel = supabase
      .channel('facturas-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tabla_2' },
        () => {
          fetchData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleFilterSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    fetchData();
  };

  const handleClearFilters = () => {
    setEmpresa('');
    setNFactura('');
    setDesde('');
    setHasta('');
    setPage(1);
  };

  return (
    <div className="container">
      <div className="header-row">
        <h1>Facturas</h1>
        <div className="header-actions">
          {lastUpdated && (
            <span className="last-updated">
              Actualizado: {lastUpdated.toLocaleTimeString('es-PE')}
            </span>
          )}
          <UploadFacturas />
        </div>
      </div>

      <form className="filters" onSubmit={handleFilterSubmit}>
        <input
          type="text"
          placeholder="Empresa"
          value={empresa}
          onChange={(e) => setEmpresa(e.target.value)}
        />
        <input
          type="text"
          placeholder="N° Factura"
          value={nFactura}
          onChange={(e) => setNFactura(e.target.value)}
        />
        <label>
          Desde
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label>
          Hasta
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <button type="submit">Filtrar</button>
        <button type="button" onClick={handleClearFilters}>
          Limpiar
        </button>
      </form>

      {loading && <p>Cargando...</p>}
      {error && <p className="error">Error: {error}</p>}

      {!loading && !error && (
        <>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Empresa</th>
                <th>N° Factura</th>
                <th>Producto</th>
                <th>Cantidad</th>
                <th>Costo</th>
                <th>Imagen</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No hay resultados
                  </td>
                </tr>
              )}
              {data.map((row) => (
                <tr key={row.id}>
                  <td>{row.fecha}</td>
                  <td>{row.empresa}</td>
                  <td>{row.n_factura}</td>
                  <td>{row.producto}</td>
                  <td>{row.cantidad}</td>
                  <td>{formatCosto(row.costo)}</td>
                  <td>
                    {row.imagen_signed_url ? (
                      <img
                        src={row.imagen_signed_url}
                        alt="Factura"
                        style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4, cursor: 'pointer' }}
                        onClick={() => setModalImage(row.imagen_signed_url)}
                      />
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </button>
            <span>
              Página {page} de {totalPages} ({total} registros)
            </span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Siguiente
            </button>
          </div>
        </>
      )}

      {modalImage && (
        <div
          onClick={() => setModalImage(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'relative', maxWidth: '90%', maxHeight: '90%' }}
          >
            <button
              onClick={() => setModalImage(null)}
              style={{
                position: 'absolute',
                top: -36,
                right: 0,
                background: 'transparent',
                color: '#fff',
                border: 'none',
                fontSize: 24,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
            <img
              src={modalImage}
              alt="Factura ampliada"
              style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: 8, display: 'block' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}