import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PROMPT_TRANSCRIBIR = `Transcribe TODO el texto visible en esta imagen o documento de factura/recibo, exactamente como aparece: fecha, nombre de la empresa, numero de factura, cada articulo o servicio con su cantidad, precio unitario e importe, y el total. Si es una tabla, transcribela renglon por renglon en el mismo orden. No resumas, no interpretes, no calcules nada: solo transcribe el contenido legible, en espanol.`;

const SYSTEM_PROMPT_EXTRACCION = `Eres un asistente experto en extraer toda la informacion relevante de facturas o de descripciones habladas de compras.

Extrae cada articulo o servicio de forma individual dentro del arreglo "Articulos". Para cada articulo incluye: "Descripcion", "Cantidad", "PrecioUnitario" (precio por unidad) e "Importe" (total de esa linea).

Reglas para "Cantidad" y "Descripcion":
- Si el articulo se mide por peso o volumen (kg, g, gr, gramos, litros, l, ml), NO pongas ese numero en "Cantidad". En su lugar, incluye la cantidad y su unidad dentro de "Descripcion", por ejemplo: "Tomate (3 kg)", "Queso (5 g)", "Aceite (2 litros)". Deja "Cantidad" como null en estos casos.
- Si el articulo se cuenta por unidades enteras (ej. "2 panes", "3 botellas", "1 factura de servicio"), pon ese numero en "Cantidad" como entero, y NO lo repitas dentro de "Descripcion".
- Si no se menciona ninguna cantidad, deja "Cantidad" como null (no inventes un 1).

Reglas para precios:
- "Importe" es siempre el total pagado por esa linea (lo que la persona dijo o lo que aparece en la factura como total de esa fila).
- "PrecioUnitario" es el precio por unidad, solo aplica cuando "Cantidad" es un numero de unidades enteras. Si el articulo se mide por peso/volumen, deja "PrecioUnitario" como null (el precio ya está reflejado en "Importe").
- Si la factura no muestra precio unitario pero si el importe de la linea, deja "PrecioUnitario" igual al "Importe" cuando la cantidad sea 1.

Reglas para SubTotal, IGV y Total:
- "SubTotal" es el importe antes de impuestos (a veces aparece como "OP. GRAVADAS", "GRAVADA" o "SUB TOTAL"). Si no aparece explicito, deja null.
- "IGV" es el impuesto (18% en Peru; puede aparecer como "I.G.V.", "IGV 18%"). Si la factura no muestra IGV, deja null (no asumas que es 0).
- "Total" es el importe final a pagar (a veces "TOTAL VENTA" o "TOTAL"). Si no aparece, sumalo de SubTotal + IGV cuando ambos existan.
- Si la factura no distingue SubTotal/IGV y solo muestra un monto final, pon ese monto en "Total" y deja "SubTotal" e "IGV" como null.

Otras reglas:
- "Empresa" es el nombre de la empresa o persona que emite la factura. Si no aparece (por ejemplo en una compra hablada sin factura), deja el campo como cadena vacia "".
- "NumeroFactura" es el numero o identificador de la factura. Si no aparece, deja "".

Debes devolver las respuestas siempre en espanol. Responde UNICAMENTE con un objeto JSON valido, sin texto adicional, sin markdown, que cumpla este schema:

{
  "Fecha": "string (YYYY-MM-DD o DD/MM/YYYY)",
  "Empresa": "string",
  "NumeroFactura": "string",
  "Articulos": [
    { "Descripcion": "string", "Cantidad": "number|null", "PrecioUnitario": "number|null", "Importe": "number|null" }
  ],
  "SubTotal": "number|null",
  "IGV": "number|null",
  "Total": "number|null"
}`;

export interface FacturaExtraida {
    Fecha?: string;
    Empresa?: string;
    NumeroFactura?: string;
    Articulos?: Array<{
        Descripcion?: string;
        Cantidad?: number | null;
        PrecioUnitario?: number | null;
        Importe?: number | null;
    }>;
    SubTotal?: number | null;
    IGV?: number | null;
    Total?: number | null;
}

@Injectable()
export class GeminiService {
    private readonly logger = new Logger(GeminiService.name);
    private readonly apiKey: string | undefined;
    private readonly model: string;

    constructor(private config: ConfigService) {
        this.apiKey = this.config.get<string>('GEMINI_API_KEY');
        this.model = this.config.get<string>('GEMINI_MODEL') || 'gemini-2.0-flash';
    }

    private async generateContent(parts: any[], generationConfig?: any) {
        if (!this.apiKey) {
            throw new InternalServerErrorException(
                'Falta configurar GEMINI_API_KEY en las variables de entorno.',
            );
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                ...(generationConfig ? { generationConfig } : {}),
            }),
        });

        const body = await res.json();

        if (!res.ok) {
            this.logger.error(`Error de Gemini: ${JSON.stringify(body)}`);
            throw new InternalServerErrorException(
                body?.error?.message || 'Error al llamar a la API de Gemini.',
            );
        }

        const text = body?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p.text || '')
            .join('');

        if (!text) {
            throw new InternalServerErrorException('Gemini no devolvió contenido.');
        }

        return text as string;
    }

    // Equivalente a "Gemini Leer Factura1" (imagen/documento) en n8n
    async transcribirImagenODocumento(buffer: Buffer, mimeType: string) {
        return this.generateContent([
            { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            { text: PROMPT_TRANSCRIBIR },
        ]);
    }

    // Equivalente a "Transcribe audio1" en n8n
    async transcribirAudio(buffer: Buffer, mimeType: string) {
        return this.generateContent([
            { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            {
                text: 'Transcribe exactamente lo que se dice en este audio, en espanol. No resumas ni interpretes.',
            },
        ]);
    }

    // Equivalente a "Information Extractor1" en n8n
    async extraerFactura(texto: string): Promise<FacturaExtraida> {
        const raw = await this.generateContent(
            [{ text: `${SYSTEM_PROMPT_EXTRACCION}\n\nTexto a analizar:\n"""${texto}"""` }],
            { responseMimeType: 'application/json' },
        );

        const limpio = raw
            .trim()
            .replace(/^```json/i, '')
            .replace(/^```/, '')
            .replace(/```$/, '')
            .trim();

        try {
            return JSON.parse(limpio);
        } catch (err) {
            this.logger.error(`No se pudo parsear JSON de Gemini: ${raw}`);
            throw new InternalServerErrorException(
                'No se pudo interpretar la respuesta de la IA como JSON.',
            );
        }
    }
}