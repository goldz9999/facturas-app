// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

// Calidad de compresión WebP. 80 es un buen balance: reduce bastante el
// peso del archivo sin degradar la legibilidad de una factura/comprobante.
const CALIDAD_WEBP = 80;

export interface ArchivoConvertido {
    buffer: Buffer;
    mimetype: string;
    ext: string;
}

// Convierte una imagen a WebP para ahorrar espacio en el bucket de Storage
// (RF de la persona: guardar imágenes en WebP por espacio). Se aplica solo a
// tipos de imagen (jpg, png, webp, etc.) — PDFs y documentos de Word no se
// tocan, se suben tal cual.
//
// Devuelve null si el mimetype no es una imagen soportada, para que el
// llamador suba el archivo original sin cambios en ese caso.
export async function convertirImagenAWebp(
    buffer: Buffer,
    mimetype: string,
): Promise<ArchivoConvertido | null> {
    if (!mimetype?.startsWith('image/')) {
        return null;
    }

    try {
        const bufferWebp = await sharp(buffer).webp({ quality: CALIDAD_WEBP }).toBuffer();
        return { buffer: bufferWebp, mimetype: 'image/webp', ext: 'webp' };
    } catch (err) {
        // Si sharp no puede procesar la imagen (formato raro, archivo
        // corrupto, binario nativo faltante en el runtime, etc.), se sube
        // el archivo original en vez de fallar toda la subida del gasto.
        // Se loguea el motivo real para poder diagnosticarlo — antes se
        // tragaba el error silenciosamente.
        console.error(`[convertirImagenAWebp] Falló la conversión, subiendo original: ${err?.message ?? err}`);
        return null;
    }
}
// Huella perceptual (dHash 16x16 = 256 bits, en hex) para detectar la MISMA
// imagen aunque se haya recomprimido o cambiado de tamaño (p. ej. reenviada
// por Telegram). Dos fotos distintas del mismo papel no coinciden: para eso
// está el número de comprobante. Devuelve null si no es una imagen legible.
const LADO_HASH = 16;
export async function huellaImagen(buffer: Buffer, mimetype: string): Promise<string | null> {
    if (!mimetype?.startsWith('image/')) return null;
    try {
        const pixeles: Buffer = await sharp(buffer)
            .rotate()
            .grayscale()
            .resize(LADO_HASH + 1, LADO_HASH, { fit: 'fill' })
            .raw()
            .toBuffer();
        let bits = '';
        for (let y = 0; y < LADO_HASH; y++) {
            for (let x = 0; x < LADO_HASH; x++) {
                const i = y * (LADO_HASH + 1) + x;
                bits += pixeles[i] < pixeles[i + 1] ? '1' : '0';
            }
        }
        let hex = '';
        for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
        return hex;
    } catch (err) {
        console.error(`[huellaImagen] No se pudo calcular: ${err?.message ?? err}`);
        return null;
    }
}

// Bits distintos entre dos huellas (0 = idénticas). Infinity si no son comparables.
export function distanciaHuella(a: string | null | undefined, b: string | null | undefined): number {
    if (!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { d += x & 1; x >>= 1; }
    }
    return d;
}

// Hasta este número de bits distintos (de 256) se considera la misma imagen.
export const UMBRAL_HUELLA = 12;
