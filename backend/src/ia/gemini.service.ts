import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PROMPT_TRANSCRIBIR = `Transcribe TODO el texto visible en esta imagen o documento de factura/recibo, exactamente como aparece: fecha, nombre de la empresa, RUC (numero de 11 digitos que suele aparecer junto al nombre de la empresa emisora), numero de factura, cada articulo o servicio con su cantidad, precio unitario e importe, y el total. Si es una tabla, transcribela renglon por renglon en el mismo orden. No resumas, no interpretes, no calcules nada: solo transcribe el contenido legible, en espanol.`;

const JSON_SCHEMA = `{
  "Fecha": "string (YYYY-MM-DD o DD/MM/YYYY)",
  "Empresa": "string",
  "RUC": "string",
  "NumeroFactura": "string",
  "Articulos": [
    { "Descripcion": "string", "Cantidad": "number|null", "PrecioUnitario": "number|null", "Importe": "number|null" }
  ],
  "SubTotal": "number|null",
  "IGV": "number|null",
  "Total": "number|null",
  "MedioPago": "\"yape\" | \"transferencia\" | \"efectivo\" | \"tarjeta\" | \"otro\" | \"\"",
  "NumeroOperacion": "string",
  "Confianza": "\"alta\" | \"media\" | \"baja\""
}`;

const REGLAS_CONFIANZA = `Reglas para "Confianza" (qué tan seguro estás de la extracción):
- "alta": el monto Total es claro y no ambiguo, y al menos la Empresa o la Fecha también son claras. No hubo que adivinar ni inferir nada importante.
- "media": el Total es claro, pero falta o es ambigua Empresa, Fecha, o el desglose de articulos; o tuviste que inferir/calcular algún dato en vez de leerlo directamente.
- "baja": el Total es dudoso, ilegible, contradictorio, o tuviste que inventarlo/estimarlo; o la imagen/audio es de mala calidad y no estás seguro de casi nada.`;

// Prompt para texto que viene de una FACTURA/RECIBO tabular (foto, PDF, doc).
const SYSTEM_PROMPT_EXTRACCION_FACTURA = `Eres un asistente experto en extraer toda la informacion relevante de facturas o recibos de compra ya transcritos.

Extrae cada articulo o servicio de forma individual dentro del arreglo "Articulos". Para cada articulo incluye: "Descripcion", "Cantidad", "PrecioUnitario" (precio por unidad) e "Importe" (total de esa linea).

Reglas para "Cantidad" y "Descripcion":
- Si el articulo se mide por peso o volumen (kg, g, gr, gramos, litros, l, ml), NO pongas ese numero en "Cantidad". En su lugar, incluye la cantidad y su unidad dentro de "Descripcion", por ejemplo: "Tomate (3 kg)", "Queso (5 g)", "Aceite (2 litros)". Deja "Cantidad" como null en estos casos.
- Si el articulo se cuenta por unidades enteras (ej. "2 panes", "3 botellas", "1 factura de servicio"), pon ese numero en "Cantidad" como entero, y NO lo repitas dentro de "Descripcion".
- Si no se menciona ninguna cantidad, deja "Cantidad" como null (no inventes un 1).

Reglas para precios:
- "Importe" es siempre el total pagado por esa linea, tal como aparece en la factura.
- "PrecioUnitario" es el precio por unidad, solo aplica cuando "Cantidad" es un numero de unidades enteras. Si el articulo se mide por peso/volumen, deja "PrecioUnitario" como null (el precio ya está reflejado en "Importe").
- Si la factura no muestra precio unitario pero si el importe de la linea, deja "PrecioUnitario" igual al "Importe" cuando la cantidad sea 1.

Reglas para SubTotal, IGV y Total:
- "SubTotal" es el importe antes de impuestos (a veces aparece como "OP. GRAVADAS", "GRAVADA" o "SUB TOTAL"). Si no aparece explicito, deja null.
- "IGV" es el impuesto (18% en Peru; puede aparecer como "I.G.V.", "IGV 18%"). Si la factura no muestra IGV, deja null (no asumas que es 0).
- "Total" es el importe final a pagar (a veces "TOTAL VENTA" o "TOTAL"). Si no aparece, sumalo de SubTotal + IGV cuando ambos existan.
- Si la factura no distingue SubTotal/IGV y solo muestra un monto final, pon ese monto en "Total" y deja "SubTotal" e "IGV" como null.

Otras reglas:
- "Empresa" es el nombre de la empresa que emite la factura. Si no aparece, deja el campo como cadena vacia "".
- CASO CAPTURA DE YAPE/TRANSFERENCIA: en estas capturas suele aparecer más de un nombre de persona en la imagen (por ejemplo un encabezado grande decorativo, y también el nombre del destinatario real de la plata). El nombre correcto para "Empresa" es el DESTINATARIO del pago (a quién se le pagó), NO el encabezado decorativo ni el nombre del titular de la cuenta que envía. Una pista fuerte: el nombre del destinatario en Yape casi siempre aparece parcialmente enmascarado con un asterisco por privacidad (ej. "Julio Esq*", "Mar** Lóp*") -- si ves un nombre con asterisco al final, ESE es el destinatario correcto para "Empresa", incluso si hay otro nombre más grande o más prominente en la imagen. Ese nombre enmascarado NUNCA debe ir dentro de "Articulos" como si fuera un producto: es el nombre de la empresa/persona, va en "Empresa".
- "RUC" es el numero de RUC de la empresa emisora (11 digitos en Peru, suele aparecer junto o debajo del nombre de la empresa, a veces precedido por "RUC:"). Si no aparece o no es legible, deja el campo como cadena vacia "".
- "NumeroFactura" es el numero o identificador de la factura. Si no aparece, deja "".

Reglas para "MedioPago" y "NumeroOperacion":
- Esta imagen puede ser una FACTURA/BOLETA (documento de compra) o una CAPTURA DE PAGO (Yape, transferencia bancaria u otro comprobante de pago). Identifica cuál es.
- Si es una captura de Yape (encabezado tipo "Yapeaste a...", logo morado de Yape, "N° de operación"), pon "MedioPago": "yape".
- Si es una captura de transferencia bancaria (logo de un banco, "N° de operación" u "operación exitosa", cuenta origen/destino), pon "MedioPago": "transferencia".
- Si la factura/boleta indica explícitamente que se pagó en efectivo o con tarjeta, usa "efectivo" o "tarjeta" segun corresponda.
- Si es una factura/boleta normal que NO trae ninguna indicación de cómo se pagó, deja "MedioPago" como "" (cadena vacia). No asumas Yape ni ningún otro medio si no hay evidencia clara en la imagen.
- "NumeroOperacion" es el número de operación/transacción que suelen mostrar las capturas de Yape o transferencia. Si no aparece, deja "".

${REGLAS_CONFIANZA}

Debes devolver las respuestas siempre en espanol. Responde UNICAMENTE con un objeto JSON valido, sin texto adicional, sin markdown, que cumpla este schema:

${JSON_SCHEMA}`;

// Variante de SYSTEM_PROMPT_EXTRACCION_FACTURA para leer DIRECTO desde la
// imagen/documento en una sola llamada a Gemini, en vez de transcribir texto
// primero y extraer después (dos llamadas). Mismas reglas de extracción,
// solo cambia la fuente (imagen adjunta en vez de texto ya transcrito) --
// ver GeminiService.extraerFacturaDeImagen.
const SYSTEM_PROMPT_EXTRACCION_FACTURA_IMAGEN = SYSTEM_PROMPT_EXTRACCION_FACTURA.replace(
    'Eres un asistente experto en extraer toda la informacion relevante de facturas o recibos de compra ya transcritos.',
    'Eres un asistente experto en leer facturas o recibos de compra directamente desde la imagen o documento adjunto (no viene texto ya transcrito: léelo tú mismo de la imagen), y extraer toda la informacion relevante.',
);

// Prompt para texto que viene de un AUDIO (persona describiendo una compra en voz alta).
const SYSTEM_PROMPT_EXTRACCION_AUDIO = `Eres un asistente experto en extraer informacion de gastos a partir de la transcripcion de un audio donde una persona describe, hablando de forma libre y coloquial, una compra o gasto que hizo. NO es una factura escaneada: es lenguaje natural, puede tener muletillas, montos redondeados o aproximados, y datos incompletos.

Extrae cada articulo o servicio mencionado dentro del arreglo "Articulos". Para cada uno incluye: "Descripcion", "Cantidad", "PrecioUnitario" e "Importe".

Reglas para "Cantidad" y "Descripcion":
- Si la persona menciona un peso o volumen (kg, g, gramos, litros, ml), NO lo pongas en "Cantidad": inclúyelo dentro de "Descripcion", ej. "Tomate (3 kg)". Deja "Cantidad" como null en estos casos.
- Si menciona unidades enteras (ej. "dos panes", "tres botellas"), conviértelo a numero en "Cantidad" y no lo repitas en "Descripcion".
- Si no menciona cantidad, deja "Cantidad" como null (no inventes un 1).
- Si la persona menciona una sola compra sin desglose de articulos (ej. "gasté 50 soles en gasolina"), crea un unico articulo con esa descripcion general.

Reglas para precios:
- "Importe" es el monto que la persona dijo haber pagado por ese articulo o por el gasto en general.
- "PrecioUnitario" solo aplica si la persona da un precio por unidad explicito y "Cantidad" es un numero entero; si no, deja null.
- Los montos hablados suelen ser aproximados: transcribe el numero tal como lo dice la persona, sin inventar decimales.

Reglas para SubTotal, IGV y Total:
- Un audio casi nunca desglosa impuestos: deja "SubTotal" e "IGV" como null salvo que la persona los mencione explicitamente.
- "Total" es el monto total del gasto. Si hay varios articulos y la persona no dio un total explicito, sumalos tu.

Otras reglas:
- "Empresa" es el nombre del negocio o proveedor si la persona lo menciona (ej. "en el grifo Primax", "en la ferreteria de la esquina"). Si no lo menciona, deja "".
- "RUC" casi nunca aplica en un audio: deja "" salvo que la persona diga explicitamente un numero de RUC.
- "NumeroFactura" casi nunca aplica en un audio: deja "" salvo que la persona diga explicitamente un numero de comprobante.
- "Fecha": si la persona menciona cuándo fue el gasto (ej. "ayer", "el lunes"), intenta inferir la fecha; si no dice nada, deja el campo vacio.
- "MedioPago": si la persona menciona explícitamente cómo pagó ("le yapeé", "pagué con tarjeta", "transferí", "en efectivo"), usa "yape" | "transferencia" | "tarjeta" | "efectivo" segun corresponda. Si no lo menciona, deja "" (no asumas).
- "NumeroOperacion" casi nunca aplica en un audio: deja "" salvo que la persona diga explicitamente un numero de operación.

${REGLAS_CONFIANZA}
En un audio es normal que la confianza rara vez sea "alta" (el usuario habla de forma aproximada): úsala solo si dio un monto y un articulo claros y sin ambigüedad.

Debes devolver las respuestas siempre en espanol. Responde UNICAMENTE con un objeto JSON valido, sin texto adicional, sin markdown, que cumpla este schema:

${JSON_SCHEMA}`;

export interface FacturaExtraida {
    Fecha?: string;
    Empresa?: string;
    RUC?: string;
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
    MedioPago?: string;
    NumeroOperacion?: string;
    Confianza?: string;
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

    // Equivalente a "Information Extractor1" en n8n.
    // esAudio=true usa el prompt afinado para lenguaje hablado/coloquial;
    // esAudio=false (default) usa el prompt para facturas/recibos tabulares.
    async extraerFactura(texto: string, esAudio = false): Promise<FacturaExtraida> {
        const systemPrompt = esAudio
            ? SYSTEM_PROMPT_EXTRACCION_AUDIO
            : SYSTEM_PROMPT_EXTRACCION_FACTURA;
        const raw = await this.generateContent(
            [{ text: `${systemPrompt}\n\nTexto a analizar:\n"""${texto}"""` }],
            { responseMimeType: 'application/json' },
        );
        return this.parsearRespuestaJson(raw);
    }

    // DEPRECADO para el flujo normal de captura de imagen/documento: combina
    // en UNA sola llamada a Gemini lo que antes eran dos pasos secuenciales
    // (transcribirImagenODocumento + extraerFactura). Se revirtió su uso en
    // facturas.service.ts porque en comprobantes manuscritos/desordenados
    // (ej. papeletas a mano) la lectura combinada perdía detalle de items
    // (cantidades, anotaciones de metraje) y a veces no lograba leer bien la
    // fecha, cayendo en el fallback silencioso de normalizarFecha (que
    // guardaba la fecha de hoy como si fuera la fecha real del comprobante).
    // Se deja el método por si se reutiliza en un contexto donde la latencia
    // importe más que la precisión, pero NO usar para el pipeline principal.
    async extraerFacturaDeImagen(buffer: Buffer, mimeType: string): Promise<FacturaExtraida> {
        const raw = await this.generateContent(
            [
                { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
                { text: SYSTEM_PROMPT_EXTRACCION_FACTURA_IMAGEN },
            ],
            { responseMimeType: 'application/json' },
        );
        return this.parsearRespuestaJson(raw);
    }

    private parsearRespuestaJson(raw: string): FacturaExtraida {
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