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