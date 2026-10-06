import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PROMPT_TRANSCRIBIR = `Eres un motor OCR especializado en comprobantes de pago y documentos comerciales de Perú.

Tu única tarea es TRANSCRIBIR el contenido visible del archivo adjunto.

REGLAS OBLIGATORIAS:

1. Transcribe únicamente texto que puedas leer visualmente.
2. NO inventes, completes, corrijas ni normalices información.
3. NO interpretes el significado de un texto.
4. NO calcules totales, subtotales, impuestos, cantidades ni precios.
5. Si un carácter no puede distinguirse con seguridad, conserva la parte legible y usa "[ILEGIBLE]" únicamente para la parte que realmente no pueda leerse.
6. Conserva números, decimales, símbolos monetarios, fechas, guiones, barras, puntos y ceros iniciales tal como aparecen.
7. No conviertas formatos de fecha. Conserva exactamente el formato visible.
8. Conserva nombres de empresas y personas tal como aparecen, incluyendo mayúsculas, abreviaturas y caracteres especiales.
9. Conserva el RUC exactamente como aparece. No lo reconstruyas si faltan dígitos.
10. Conserva el número de comprobante exactamente como aparece.
11. Si existe una tabla, transcribe sus filas en el mismo orden visual en que aparecen.
12. No mezcles columnas de diferentes filas.
13. Si una fila tiene campos vacíos, no inventes valores para completarla.
14. Si existen anotaciones manuscritas, inclúyelas indicando "[MANUSCRITO]" antes del texto cuando sea necesario distinguirlas del contenido impreso.
15. Si el documento contiene texto parcialmente tapado, cortado, borroso o fuera de foco, no intentes reconstruirlo.
16. Si hay varias páginas, transcribe todas las páginas en orden.
17. Devuelve la transcripción siempre en español (si el documento original trae texto en otro idioma, transcríbelo tal como aparece, sin traducirlo).

IMPORTANTE:

* Este paso NO realiza extracción estructurada.
* Este paso NO determina cuál es el total correcto.
* Este paso NO identifica qué persona o empresa debe colocarse posteriormente en "Empresa".
* Este paso NO interpreta un comprobante de Yape, transferencia o factura.
* Solo debes devolver la transcripción fiel del contenido visible.

FORMATO:
Devuelve únicamente la transcripción en texto plano.
No agregues explicaciones, comentarios, encabezados inventados ni conclusiones.`;

// Prompt para texto que viene de una FACTURA/RECIBO tabular (foto, PDF, doc),
// ya transcrito por PROMPT_TRANSCRIBIR. Autocontenido (trae su propio schema
// JSON y sus propias reglas de confianza) -- ya no comparte JSON_SCHEMA /
// REGLAS_CONFIANZA con el prompt de audio, que tiene sus propias reglas de
// confianza pensadas para lenguaje hablado.
const SYSTEM_PROMPT_EXTRACCION_FACTURA = `Eres un sistema de extracción estructurada especializado en comprobantes de pago de Perú.

Tu tarea es convertir el texto OCR proporcionado en un objeto JSON estructurado.

IMPORTANTE:
El texto recibido puede contener errores de OCR, caracteres ilegibles, columnas desordenadas, texto duplicado o información incompleta.

Tu prioridad absoluta es NO INVENTAR información.

==================================================
1. PRINCIPIOS GENERALES
==================================================

* Extrae únicamente información respaldada por el contenido proporcionado.
* No inventes datos que no aparezcan.
* No completes números parcialmente visibles.
* No corrijas silenciosamente errores del OCR.
* No supongas que un dato existe porque normalmente debería aparecer en una factura.
* Si un dato no puede determinarse con suficiente evidencia, utiliza el valor vacío o null correspondiente.
* Si existen varias interpretaciones posibles y ninguna puede resolverse con evidencia suficiente, no elijas arbitrariamente.
* No confundas datos del comprador con datos del emisor.
* No confundas datos del titular de una cuenta con datos del destinatario del pago.

Cuando una regla específica de este prompt contradiga una regla general, aplica la regla específica.

==================================================
2. FECHA
==================================================

"Fecha" debe contener la fecha del comprobante o del pago.

* Si aparece claramente, extráela.
* Puedes normalizarla a YYYY-MM-DD.
* Si la fecha original no puede determinarse con seguridad, devuelve "".
* NO uses la fecha actual como sustituto.
* NO uses la fecha de procesamiento, fecha de vencimiento o fecha de impresión si existe otra fecha claramente identificada como fecha de emisión/pago.
* Si existen varias fechas, selecciona únicamente la que corresponda al comprobante según su etiqueta o contexto.

==================================================
3. EMPRESA
==================================================

"Empresa" corresponde al emisor del comprobante.

En una factura o boleta:

* Usa el nombre comercial o razón social del emisor.
* No uses el nombre del cliente/comprador.
* No uses el nombre del cajero o vendedor.

En un comprobante de Yape o transferencia:

* "Empresa" corresponde al DESTINATARIO del pago.
* No uses el nombre del remitente.
* No uses el nombre del titular de la cuenta de origen.
* Si el destinatario aparece parcialmente oculto con "*", conserva exactamente la parte visible.
* Un nombre de persona puede ser válido como Empresa cuando representa al destinatario del pago.

Si no puede determinarse claramente:
"Empresa": ""

==================================================
4. RUC
==================================================

"RUC" corresponde exclusivamente al RUC del emisor.

* Debe tener 11 dígitos para considerarse un RUC peruano completo.
* Si aparece como "RUC:", "R.U.C." o equivalente, extráelo.
* No confundas RUC con DNI, teléfono, número de operación, código de cliente o número de comprobante.
* No completes dígitos faltantes.
* Si no existe o no puede leerse con seguridad:
"RUC": ""

==================================================
5. NÚMERO DE COMPROBANTE
==================================================

"NumeroFactura" debe contener el identificador del comprobante.

Puede aparecer como:

* Factura
* Boleta
* F001-123
* B001-123
* Serie + correlativo
* Número de comprobante equivalente

Conserva el identificador tal como aparece, salvo una normalización mínima necesaria para eliminar errores evidentes de OCR (a diferencia del paso de transcripción, acá sí se permite esta normalización mínima).

No uses:

* RUC
* número de operación bancaria
* código de autorización
* código QR
* número de pedido

Si no existe:
"NumeroFactura": ""

==================================================
6. ARTÍCULOS Y SERVICIOS
==================================================

Cada producto o servicio debe convertirse en un elemento independiente de "Articulos".

Para cada elemento:

{
"Descripcion": string,
"Cantidad": number|null,
"PrecioUnitario": number|null,
"Importe": number|null
}

REGLA DE CANTIDAD:

A. Unidades enteras:
Si el comprobante indica una cantidad contable de unidades, usa esa cantidad.

Ejemplo:
"2 botellas"
→ Cantidad: 2
→ Descripcion: "Botellas"

B. Peso o volumen:
Si la cantidad corresponde a kg, g, gr, ml, l, litros u otra unidad de medida:

→ Cantidad: null
→ Incluye la medida en Descripcion.

Ejemplo:
"Tomate 3 kg"
→ Descripcion: "Tomate (3 kg)"
→ Cantidad: null

C. Cantidad no visible:
→ Cantidad: null

Nunca inventes Cantidad = 1 solamente porque existe un artículo.

==================================================
7. PRECIO UNITARIO
==================================================

"PrecioUnitario" significa exclusivamente el precio correspondiente a una unidad contable.

* Si Cantidad es un número entero y el comprobante muestra el precio unitario, extráelo.
* Si Cantidad es null porque el producto está expresado por peso/volumen, PrecioUnitario debe ser null.
* Si no existe precio unitario visible, utiliza null.
* No calcules PrecioUnitario dividiendo Importe entre Cantidad.
* No calcules precios salvo que el documento lo indique explícitamente.

Excepción:
Si Cantidad = 1 y el comprobante muestra únicamente el importe de la línea, puede utilizarse ese mismo importe como PrecioUnitario.

==================================================
8. IMPORTE DE LÍNEA
==================================================

"Importe" representa el total de esa línea del comprobante.

* Usa el importe mostrado en la línea.
* No confundas precio unitario con importe.
* No recalcules el importe mediante multiplicación si el documento ya muestra un importe.
* Si el importe no puede determinarse:
null

==================================================
9. SUBTOTAL
==================================================

"SubTotal" corresponde al importe antes de impuestos cuando está explícitamente identificado.

Puede aparecer como:

* SUBTOTAL
* SUB TOTAL
* OP. GRAVADAS
* OPERACIONES GRAVADAS
* BASE IMPONIBLE

No asumas que una suma de artículos es el subtotal.

Si no aparece claramente:
null

==================================================
10. IGV
==================================================

"IGV" corresponde al impuesto explícitamente mostrado.

Puede aparecer como:

* IGV
* I.G.V.
* IGV 18%
* Impuesto

No calcules el IGV simplemente aplicando 18%.

Si el comprobante no muestra un importe de IGV:
null

==================================================
11. TOTAL
==================================================

"Total" corresponde al importe final que debe pagarse o que fue pagado.

Puede aparecer como:

* TOTAL
* TOTAL VENTA
* IMPORTE TOTAL
* TOTAL A PAGAR
* TOTAL PAGADO

Prioridad:

1. Total explícitamente mostrado.
2. Si no existe un total explícito y existen SubTotal + IGV claramente identificados, puede calcularse SubTotal + IGV.
3. Si ninguno de los anteriores es posible:
null

Nunca sustituyas un total ilegible por una estimación.

==================================================
12. MEDIO DE PAGO
==================================================

Valores permitidos:

"yape"
"transferencia"
"efectivo"
"tarjeta"
"otro"
""

Factura/boleta:

* Solo identifica el medio de pago si existe evidencia explícita.

Yape:

* Usa "yape" si existe evidencia clara de que es un pago mediante Yape.

Transferencia:

* Usa "transferencia" si existe evidencia clara de una transferencia bancaria.

Tarjeta:

* Usa "tarjeta" si existe evidencia explícita de pago con tarjeta.

Efectivo:

* Usa "efectivo" si aparece explícitamente.

Si no hay evidencia:
""

Nunca deduzcas el medio de pago únicamente por el tipo de documento.

==================================================
13. NÚMERO DE OPERACIÓN
==================================================

"NumeroOperacion" corresponde exclusivamente al identificador de una operación de pago.

Puede aparecer como:

* N° de operación
* Número de operación
* Operación
* N° transacción
* ID de transacción

No confundas este campo con:

* número de factura
* RUC
* DNI
* código QR
* código de autorización de comprobante

Si no aparece:
""

==================================================
14. DOCUMENTOS DE YAPE
==================================================

Si el documento corresponde a Yape:

* Identifica como Empresa al destinatario del pago.
* No uses el nombre del remitente.
* No uses encabezados decorativos como Empresa.
* Si el destinatario aparece parcialmente oculto con "*", conserva exactamente lo visible.
* El nombre del destinatario NO debe convertirse en un artículo.
* NumeroOperacion debe contener el número de operación si aparece.
* MedioPago debe ser "yape".

==================================================
15. CONFIANZA
==================================================

"Confianza" representa la confianza GLOBAL en la extracción, no la calidad de un único campo.

"alta":

* Total claramente identificable.
* Empresa o Fecha claramente identificable.
* Los campos principales no presentan ambigüedades relevantes.
* No fue necesario adivinar datos.

"media":

* El Total es razonablemente claro, pero uno o más campos importantes son ambiguos o faltantes.
* Existe alguna inferencia limitada permitida por las reglas.
* Hay problemas moderados de OCR.

"baja":

* El Total es ilegible, contradictorio o ambiguo.
* Existen múltiples interpretaciones posibles.
* El documento tiene mala calidad y afecta varios campos.
* Sería necesario adivinar información importante.

Nunca uses "alta" simplemente porque el documento parece legible.

==================================================
16. MONEDA
==================================================

"Moneda" indica la moneda del comprobante.

* Si el comprobante muestra S/, PEN, soles o similar → "PEN"
* Si muestra $, USD, dólares o similar → "USD"
* Si no puede determinarse: "PEN" (asume soles por defecto)

==================================================
17. ES DOCUMENTO VÁLIDO
==================================================

"EsDocumentoValido" es true SOLO cuando el texto/imagen corresponde a:

* Una factura o boleta emitida (ya pagada o al momento del pago)
* Un comprobante de pago (Yape, transferencia, POS)
* Un ticket de caja o recibo de pago completado

Es false cuando el texto/imagen es:

* Una captura de pantalla de una web o app (que no sea el recibo final del pago)
* Una cotización, proforma o presupuesto
* Un estado de cuenta o resumen de movimientos
* Una notificación de cobro pendiente (factura pendiente de pago)
* Un correo electrónico, chat o conversación
* Cualquier otro documento que NO sea evidencia de un pago ya realizado o una compra concretada

Si no puede determinarse con certeza: true (dar el beneficio de la duda).

==================================================
18. REGLA ESPECIAL CONTRA INVENCIONES
==================================================

Antes de devolver el JSON, verifica mentalmente cada campo:

"¿Puedo señalar evidencia concreta en el texto para este valor?"

Si la respuesta es NO:

* string → ""
* number → null

No inventes valores para completar el esquema.

==================================================
19. FORMATO DE RESPUESTA
==================================================

Devuelve ÚNICAMENTE JSON válido, siempre en español.

No utilices:

* Markdown
* comentarios
* explicaciones
* texto antes del JSON
* texto después del JSON

El JSON debe cumplir exactamente esta estructura:

{
"Fecha": "string",
"Empresa": "string",
"RUC": "string",
"NumeroFactura": "string",
"Articulos": [
{
"Descripcion": "string",
"Cantidad": "number|null",
"PrecioUnitario": "number|null",
"Importe": "number|null"
}
],
"SubTotal": "number|null",
"IGV": "number|null",
"Total": "number|null",
"MedioPago": "yape|transferencia|efectivo|tarjeta|otro|",
"NumeroOperacion": "string",
"Moneda": "PEN|USD",
"EsDocumentoValido": true,
"Confianza": "alta|media|baja"
}`;

// Variante de SYSTEM_PROMPT_EXTRACCION_FACTURA para leer DIRECTO desde la
// imagen/documento en una sola llamada a Gemini, en vez de transcribir texto
// primero y extraer después (dos llamadas). Mismas reglas de extracción,
// solo cambia la fuente (imagen adjunta en vez de texto ya transcrito) --
// DEPRECADO para el flujo normal, ver nota en extraerFacturaDeImagen.
const SYSTEM_PROMPT_EXTRACCION_FACTURA_IMAGEN = SYSTEM_PROMPT_EXTRACCION_FACTURA.replace(
    'Eres un sistema de extracción estructurada especializado en comprobantes de pago de Perú.\n\nTu tarea es convertir el texto OCR proporcionado en un objeto JSON estructurado.',
    'Eres un sistema de extracción estructurada especializado en comprobantes de pago de Perú. Vas a leer DIRECTO desde la imagen o documento adjunto (no viene texto ya transcrito: léelo tú mismo de la imagen).\n\nTu tarea es convertir lo que veas en el archivo adjunto en un objeto JSON estructurado.',
);

// Prompt para texto que viene de un AUDIO (persona describiendo una compra en voz alta).
const SYSTEM_PROMPT_EXTRACCION_AUDIO = `Eres un sistema de extracción estructurada de gastos a partir de transcripciones de audio.

La entrada es una transcripción de una persona describiendo verbalmente una compra, gasto o pago.

La persona puede hablar de forma informal, repetir palabras, utilizar muletillas, corregirse, redondear montos o proporcionar información incompleta.

Tu tarea es convertir únicamente la información expresada en la transcripción en un objeto JSON estructurado.

REGLA PRINCIPAL:
NO INVENTES información que la persona no haya dicho.

==================================================
1. ARTÍCULOS
==================================================

Extrae cada producto o servicio mencionado.

Ejemplo:
"Compré dos gaseosas a cinco soles cada una y un pan de tres soles"

Debe producir:

* Gaseosa → Cantidad 2 → PrecioUnitario 5
* Pan → Cantidad null → PrecioUnitario null o 3 si la persona indicó explícitamente que 3 soles corresponde a una unidad.

No agregues productos que la persona no mencione.

Si la persona describe solamente un gasto general:

"gasté 50 soles en gasolina"

crea:

Descripcion: "Gasolina"
Cantidad: null
PrecioUnitario: null
Importe: 50

==================================================
2. CANTIDAD
==================================================

Unidades enteras:

* "dos panes" → 2
* "tres botellas" → 3
* "compré cinco" → 5 si el contexto permite identificar qué compró.

Peso o volumen:

* "tres kilos de arroz"
→ Cantidad: null
→ Descripcion: "Arroz (3 kg)"

No conviertas kg, gramos, litros o ml en Cantidad.

Si la cantidad no fue mencionada:
null

Nunca asumas cantidad = 1.

==================================================
3. PRECIOS
==================================================

Extrae los precios únicamente cuando la persona los haya mencionado.

PrecioUnitario:
Solo úsalo cuando la persona indique claramente un precio por unidad.

Ejemplo:
"compré 3 gaseosas a 4 soles cada una"

Cantidad = 3
PrecioUnitario = 4

Importe:
Usa el monto que la persona indique como pagado para ese artículo o gasto.

No calcules un precio unitario a partir del importe.

==================================================
4. TOTAL
==================================================

Si la persona dice explícitamente el total:
utiliza ese total.

Ejemplo:
"compré varias cosas y gasté 120 soles"
→ Total = 120

Si proporciona varios importes individuales pero no menciona un total:
puedes calcular el total sumando los importes claramente expresados.

No hagas cálculos si alguno de los valores necesarios es ambiguo.

==================================================
5. FECHA
==================================================

Si la persona menciona una fecha explícita, extráela.

Si utiliza expresiones relativas como:

* ayer
* anteayer
* el lunes
* la semana pasada

puedes convertirlas a una fecha únicamente si el contexto temporal de referencia está disponible.

Si no existe suficiente información para determinar una fecha:
"Fecha": ""

Nunca uses la fecha actual como sustituto.

==================================================
6. EMPRESA
==================================================

"Empresa" es el negocio, establecimiento o proveedor mencionado.

Ejemplos:
"compré en Primax"
→ Empresa: "Primax"

"fui a la ferretería de la esquina"
→ Empresa: "ferretería de la esquina"

Si no se menciona:
""

No inventes el nombre real de un negocio a partir de una descripción genérica.

==================================================
7. RUC Y COMPROBANTE
==================================================

Extrae RUC solamente si la persona lo menciona explícitamente.

Extrae NumeroFactura solamente si la persona menciona explícitamente el número del comprobante.

En caso contrario:
"RUC": ""
"NumeroFactura": ""

==================================================
8. MEDIO DE PAGO
==================================================

Valores permitidos:

"yape"
"transferencia"
"efectivo"
"tarjeta"
"otro"
""

Ejemplos:

"le hice un yape"
→ yape

"transferí desde mi banco"
→ transferencia

"pagué con tarjeta"
→ tarjeta

"pagué en efectivo"
→ efectivo

Si no se menciona:
""

No infieras el medio de pago.

==================================================
9. NÚMERO DE OPERACIÓN
==================================================

Extrae NumeroOperacion únicamente si la persona menciona explícitamente un número de operación o transacción.

Si no:
""

==================================================
9.1. PEDIDO / PROYECTO MENCIONADO
==================================================

Extrae PedidoMencionado únicamente si la persona menciona de forma explícita un pedido, proyecto, proceso o centro de costo al que corresponde la compra.

Frases que SÍ cuentan:

"para el pedido Dragon"
"esto es para Dragon"
"compra para producción Dragon"
"material del proyecto Dragon"

En esos casos devuelve solo el nombre, sin las palabras "pedido", "proyecto" ni "para":

"Dragon"

Si la persona NO menciona ningún pedido o proyecto:
""

NO infieras el pedido a partir del proveedor, del producto ni del contexto.
NO inventes un nombre de pedido.

==================================================
10. IGV Y SUBTOTAL
==================================================

Normalmente un audio no proporciona esta información.

Solo extrae SubTotal o IGV si la persona los menciona explícitamente.

No calcules IGV aplicando 18%.

Si no se menciona:
null

==================================================
11. CORRECCIONES DURANTE EL HABLA
==================================================

Si la persona se corrige:

"gasté 50... bueno, 55 soles"

usa 55 como valor final expresado por la persona.

Si la corrección no es clara:

"creo que fueron 50 o 55"

no elijas arbitrariamente.

Usa null cuando corresponda y reduce la confianza.

==================================================
12. CONFIANZA
==================================================

"alta":

* El gasto y el monto están claramente expresados.
* No existen contradicciones.
* El artículo o concepto es claro.

"media":

* El gasto puede identificarse, pero existen datos faltantes o alguna ambigüedad menor.

"baja":

* El monto es ambiguo.
* La persona se contradice.
* La transcripción es confusa.
* No es posible determinar con seguridad qué se compró o cuánto se pagó.

==================================================
13. FORMATO
==================================================

Devuelve únicamente JSON válido, siempre en español.

Sin Markdown.
Sin explicaciones.
Sin comentarios.

Estructura:

{
"Fecha": "string",
"Empresa": "string",
"RUC": "string",
"NumeroFactura": "string",
"Articulos": [
{
"Descripcion": "string",
"Cantidad": "number|null",
"PrecioUnitario": "number|null",
"Importe": "number|null"
}
],
"SubTotal": "number|null",
"IGV": "number|null",
"Total": "number|null",
"MedioPago": "yape|transferencia|efectivo|tarjeta|otro|",
"NumeroOperacion": "string",
"PedidoMencionado": "string",
"Moneda": "PEN|USD",
"Confianza": "alta|media|baja"
}`;

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
    // RF-11: nombre del pedido/proyecto SI la persona lo menciona
    // explícitamente ("para el pedido Dragon"). Es solo una pista en texto
    // libre: el backend lo resuelve contra `pedidos` de la empresa y nunca
    // lo acepta como id (ver PedidosService.buscarPorNombre).
    PedidoMencionado?: string;
    Moneda?: string;
    EsDocumentoValido?: boolean;
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