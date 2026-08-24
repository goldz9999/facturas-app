import { useCallback, useEffect, useRef, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const TIPOS_ACEPTADOS = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function idUnico() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function UploadFacturas() {
    const [modalOpen, setModalOpen] = useState(false);
    const [dragPageActive, setDragPageActive] = useState(false);
    const [items, setItems] = useState([]); // {id, nombre, estado, mensaje}
    const dragCounterRef = useRef(0);

    // --- Usuario (demo): mientras no hay login, se ingresa el ID a mano.
    // El frontend definitivo lo reemplazará por el usuario autenticado.
    const [usuarioId, setUsuarioId] = useState(() => localStorage.getItem('demo_usuario_id') || '');
    const usuarioIdRef = useRef(usuarioId);

    useEffect(() => {
        usuarioIdRef.current = usuarioId;
        localStorage.setItem('demo_usuario_id', usuarioId);
    }, [usuarioId]);

    // --- Modo de procesamiento (global: afecta subida y bot de Telegram) ---
    const [modo, setModo] = useState('n8n');
    const [modoCargando, setModoCargando] = useState(false);
    const modoRef = useRef(modo);

    useEffect(() => {
        modoRef.current = modo;
    }, [modo]);

    // Cargar el modo actual desde el backend al montar
    useEffect(() => {
        let cancelado = false;
        (async () => {
            try {
                const res = await fetch(`${API_URL}/facturas/modo`);
                const json = await res.json();
                if (!cancelado && json?.modo) {
                    setModo(json.modo);
                }
            } catch {
                // si falla, nos quedamos con el valor por defecto
            }
        })();
        return () => {
            cancelado = true;
        };
    }, []);

    const cambiarModo = useCallback(async (nuevoModo) => {
        if (nuevoModo === modoRef.current) return;
        const anterior = modoRef.current;
        setModo(nuevoModo);
        setModoCargando(true);
        try {
            const res = await fetch(`${API_URL}/facturas/modo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modo: nuevoModo }),
            });
            if (!res.ok) throw new Error('No se pudo actualizar el modo');
        } catch (err) {
            // revertir si falla el guardado
            setModo(anterior);
        } finally {
            setModoCargando(false);
        }
    }, []);

    const subirArchivos = useCallback(async (fileList) => {
        const files = Array.from(fileList || []).filter((f) =>
            TIPOS_ACEPTADOS.includes(f.type),
        );
        if (files.length === 0) return;

        if (modoRef.current === 'backend' && !usuarioIdRef.current) {
            setModalOpen(true);
            alert('Ingresa el ID de usuario antes de subir (obligatorio en modo Backend).');
            return;
        }

        const nuevos = files.map((f) => ({
            id: idUnico(),
            nombre: f.name,
            estado: 'subiendo',
            mensaje: '',
        }));
        setItems((prev) => [...nuevos, ...prev]);
        setModalOpen(true);

        const formData = new FormData();
        files.forEach((f) => formData.append('files', f));

        try {
            const usuarioQs = usuarioIdRef.current
                ? `&usuario_id=${encodeURIComponent(usuarioIdRef.current)}`
                : '';
            const res = await fetch(
                `${API_URL}/facturas/upload?modo=${modoRef.current}${usuarioQs}`,
                {
                    method: 'POST',
                    body: formData,
                },
            );
            const json = await res.json();

            if (!res.ok) {
                throw new Error(json?.message || 'Error al subir los archivos');
            }

            setItems((prev) =>
                prev.map((item) => {
                    const idx = nuevos.findIndex((n) => n.id === item.id);
                    if (idx === -1) return item;
                    const resultado = json.resultados?.[idx];
                    if (!resultado) {
                        return { ...item, estado: 'error', mensaje: 'Sin respuesta del servidor' };
                    }
                    return {
                        ...item,
                        estado: resultado.ok ? 'listo' : 'error',
                        mensaje: resultado.ok
                            ? 'Procesado correctamente'
                            : resultado.error || 'Error al procesar',
                    };
                }),
            );
        } catch (err) {
            setItems((prev) =>
                prev.map((item) =>
                    nuevos.some((n) => n.id === item.id)
                        ? { ...item, estado: 'error', mensaje: err.message || 'Error de red' }
                        : item,
                ),
            );
        }
    }, []);

    useEffect(() => {
        const onDragEnter = (e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            dragCounterRef.current += 1;
            setDragPageActive(true);
        };
        const onDragOver = (e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
        };
        const onDragLeave = (e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            dragCounterRef.current -= 1;
            if (dragCounterRef.current <= 0) {
                dragCounterRef.current = 0;
                setDragPageActive(false);
            }
        };
        const onDrop = (e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            dragCounterRef.current = 0;
            setDragPageActive(false);
            subirArchivos(e.dataTransfer.files);
        };

        window.addEventListener('dragenter', onDragEnter);
        window.addEventListener('dragover', onDragOver);
        window.addEventListener('dragleave', onDragLeave);
        window.addEventListener('drop', onDrop);
        return () => {
            window.removeEventListener('dragenter', onDragEnter);
            window.removeEventListener('dragover', onDragOver);
            window.removeEventListener('dragleave', onDragLeave);
            window.removeEventListener('drop', onDrop);
        };
    }, [subirArchivos]);

    const handleInputChange = (e) => {
        subirArchivos(e.target.files);
        e.target.value = '';
    };

    return (
        <>
            <button type="button" className="btn-subir-factura" onClick={() => setModalOpen(true)}>
                📤 Subir factura
            </button>

            {dragPageActive && !modalOpen && (
                <div className="drop-overlay">
                    <div className="drop-overlay-box">Suelta aquí tus imágenes o documentos</div>
                </div>
            )}

            {modalOpen && (
                <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
                    <div className="modal-box" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Subir facturas</h2>
                            <button type="button" className="modal-close" onClick={() => setModalOpen(false)}>
                                ✕
                            </button>
                        </div>

                        <div className="modo-switch">
                            <span className="modo-switch-label">
                                Procesar con: {modoCargando && <em className="modo-switch-sync">(sincronizando…)</em>}
                            </span>
                            <div className="modo-switch-toggle" role="group" aria-label="Modo de procesamiento (afecta también al bot de Telegram)">
                                <button
                                    type="button"
                                    className={`modo-switch-opcion ${modo === 'n8n' ? 'activo' : ''}`}
                                    onClick={() => cambiarModo('n8n')}
                                >
                                    n8n
                                </button>
                                <button
                                    type="button"
                                    className={`modo-switch-opcion ${modo === 'backend' ? 'activo' : ''}`}
                                    onClick={() => cambiarModo('backend')}
                                >
                                    Backend
                                </button>
                            </div>
                        </div>
                        <p className="modo-switch-hint">
                            Este modo es global: también decide cómo procesa el bot de Telegram, no solo esta subida.
                        </p>

                        {modo === 'backend' && (
                            <div className="usuario-id-field">
                                <label htmlFor="usuario-id-input">
                                    ID de usuario (demo — se reemplazará por login)
                                </label>
                                <input
                                    id="usuario-id-input"
                                    type="number"
                                    min="1"
                                    value={usuarioId}
                                    onChange={(e) => setUsuarioId(e.target.value)}
                                    placeholder="ej. 1"
                                />
                            </div>
                        )}

                        <label className="dropzone">
                            <input
                                type="file"
                                multiple
                                accept={TIPOS_ACEPTADOS.join(',')}
                                onChange={handleInputChange}
                                style={{ display: 'none' }}
                            />
                            <span className="dropzone-icon">📎</span>
                            <span>Arrastra imágenes o documentos aquí, o haz clic para elegirlos</span>
                            <span className="dropzone-hint">JPG, PNG, WEBP o PDF · máx 15MB c/u</span>
                        </label>

                        {items.length > 0 && (
                            <ul className="upload-list">
                                {items.map((item) => (
                                    <li key={item.id} className={`upload-item upload-${item.estado}`}>
                                        <span className="upload-nombre">{item.nombre}</span>
                                        <span className="upload-estado">
                                            {item.estado === 'subiendo' && '⏳ Procesando...'}
                                            {item.estado === 'listo' && `✅ ${item.mensaje}`}
                                            {item.estado === 'error' && `❌ ${item.mensaje}`}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}