// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
import { distanciaHuella, huellaImagen, UMBRAL_HUELLA } from './imagen.util';

// Imagen de prueba: degradado con un rectángulo oscuro en (x, y).
async function imagen(x: number, y: number, ancho = 400, alto = 300, formato: 'png' | 'jpeg' = 'png') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">
      <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#999"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/><rect x="${x}" y="${y}" width="120" height="80" fill="#222"/>
      <circle cx="${ancho - x}" cy="${alto - y}" r="40" fill="#555"/></svg>`;
    const s = sharp(Buffer.from(svg));
    return formato === 'png' ? s.png().toBuffer() : s.jpeg({ quality: 40 }).toBuffer();
}

describe('huellaImagen', () => {
    it('la misma imagen recomprimida y redimensionada coincide', async () => {
        const a = await huellaImagen(await imagen(40, 40), 'image/png');
        const b = await huellaImagen(await sharp(await imagen(40, 40, 400, 300, 'jpeg')).resize(200, 150).toBuffer(), 'image/jpeg');
        expect(a).toHaveLength(64);
        expect(distanciaHuella(a, b)).toBeLessThanOrEqual(UMBRAL_HUELLA);
    });

    it('imágenes distintas no coinciden', async () => {
        const a = await huellaImagen(await imagen(40, 40), 'image/png');
        const b = await huellaImagen(await imagen(240, 180), 'image/png');
        expect(distanciaHuella(a, b)).toBeGreaterThan(UMBRAL_HUELLA);
    });

    it('un PDF no tiene huella', async () => {
        expect(await huellaImagen(Buffer.from('x'), 'application/pdf')).toBeNull();
        expect(distanciaHuella(null, 'ab')).toBe(Infinity);
    });
});
