import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { UsuarioLockService } from '../common/usuario-lock.service';
import { GeminiService } from '../ia/gemini.service';
import type { FacturaExtraida } from '../ia/gemini.service';
import { normalizarFactura } from './facturas-normalizer';
import { GastosService } from '../gastos/gastos.service';
import { convertirImagenAWebp, huellaImagen } from './imagen.util';
import { ProveedoresService } from '../proveedores/proveedores.service';

const BUCKET = 'Facturas';

// Forma mínima que necesitamos de un archivo, para poder reusar el mismo
// pipeline tanto con archivos de Multer (upload web) como con archivos
// descargados de la API de Telegram.
export interface ArchivoEntrada {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

@Injectable()
export class FacturasService {
  constructor(
    private supabase: SupabaseService,
    private gemini: GeminiService,
    private gastosService: GastosService,
    private proveedoresService: ProveedoresService,
    private usuarioLock: UsuarioLockService,
  ) { }

  // Punto de entrada único: procesa el archivo directamente en el backend
  // (Gemini + Supabase). usuarioId es obligatorio: todo gasto queda
  // vinculado al usuario que lo subió (RF de trazabilidad).
  async procesarArchivos(files: Array<Express.Multer.File>, usuarioId: number) {
    return this.procesarArchivosEnBackend(files, usuarioId);
  }

  // Reemplaza todo el workflow de n8n: sube la imagen a Supabase Storage,
  // transcribe con Gemini, extrae los datos estructurados y guarda
  // el gasto (+ comprobante + evidencia) en el esquema nuevo.
  private async procesarArchivosEnBackend(
    files: Array<Express.Multer.File>,
    usuarioId: number,
  ) {
    const resultados = await Promise.all(
      files.map(async (file) => {
        try {
          const resultado = await this.procesarArchivoIndividual(file, usuarioId);
          return { archivo: file.originalname, ok: true, resultado };
        } catch (err) {
          return {
            archivo: file.originalname,
            ok: false,
            error: err.message || 'Error desconocido al procesar la factura',
          };
        }
      }),
    );

    return { resultados };
  }

  // Pipeline completo (subir a Storage + Gemini + guardar en el esquema
  // gastos/comprobantes/evidencias). Público porque también lo usa
  // TelegramService para procesar audios/fotos/documentos recibidos por el
  // bot, sin pasar por n8n. usuarioId identifica quién generó el gasto
  // (para Telegram: el usuario autorizado que escribió; para el upload
  // web: el usuario logueado en el frontend).
  async procesarArchivoIndividual(
    file: ArchivoEntrada,
    usuarioId: number,
    origen: 'web' | 'telegram' = 'web',
  ) {
    const mimeType = file.mimetype || 'application/octet-stream';
    const esAudio = mimeType.startsWith('audio/');
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'docx',
    };
    const extPorNombre = file.originalname?.includes('.')
      ? file.originalname.split('.').pop()
      : undefined;
    const ext = extPorNombre || extMap[mimeType] || 'bin';
    const nombreArchivo = `web_${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;

    // 1. Subir el archivo original a Supabase Storage (igual que "Guardar Imagen1")
    //    Si es una imagen (no PDF/doc), se convierte a WebP antes de subir
    //    para ahorrar espacio en el bucket; el buffer original (sin
    //    convertir) se sigue usando para Gemini más abajo, no se pierde
    //    calidad para la extracción.
    //
    // OPTIMIZACIÓN DE LATENCIA: antes esto se esperaba (await) completo antes
    // de siquiera empezar a llamar a Gemini, aunque son dos operaciones
    // independientes (Gemini usa el buffer ORIGINAL, no el que se sube a
    // Storage) -- el usuario esperaba la suma de ambos tiempos en vez del
    // máximo. Ahora ambas corren en paralelo con Promise.all.
    let nombreArchivoFinal = nombreArchivo;
    let subidaStorage: Promise<void> = Promise.resolve();
    // Huella de la imagen original para detectar la misma foto enviada otra vez.
    const huella = esAudio ? null : await huellaImagen(file.buffer, mimeType);
    if (!esAudio) {
      const convertida = await convertirImagenAWebp(file.buffer, mimeType);
      const bufferASubir = convertida?.buffer ?? file.buffer;
      const mimeASubir = convertida?.mimetype ?? mimeType;
      if (convertida) {
        nombreArchivoFinal = `web_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
      }

      subidaStorage = this.supabase
        .getClient()
        .storage.from(BUCKET)
        .upload(nombreArchivoFinal, bufferASubir, {
          contentType: mimeASubir,
          upsert: true,
        })
        .then(({ error: uploadError }) => {
          if (uploadError) {
            throw new InternalServerErrorException(
              `Error subiendo el archivo: ${uploadError.message}`,
            );
          }
        });
    } else {
      // Para audio: subir el archivo original a Storage para que quede como
      // evidencia adjunta al gasto (el bot notificará al usuario que puede
      // ver el audio en el panel web).
      subidaStorage = this.supabase
        .getClient()
        .storage.from(BUCKET)
        .upload(nombreArchivoFinal, file.buffer, {
          contentType: mimeType,
          upsert: true,
        })
        .then(({ error: uploadError }) => {
          if (uploadError) {
            this.logger.warn(`No se pudo subir el audio a Storage: ${uploadError.message}`);
            // No lanzamos error: el gasto se registra igual sin evidencia de audio
          }
        });
    }

    // 2+3. Transcribir + extraer con Gemini.
    // REVERTIDO (ver nota en GeminiService.extraerFacturaDeImagen): la
    // versión de "una sola llamada" multimodal perdía precisión en
    // comprobantes manuscritos/desordenados (perdía cantidades y
    // anotaciones, y a veces no leía bien la fecha). Volvemos a las dos
    // llamadas secuenciales (transcribirImagenODocumento -> texto plano,
    // luego extraerFactura -> JSON): el paso de transcripción dedicado le da
    // a Gemini mejor terreno para leer letra por letra antes de estructurar.
    // El upload a Storage sigue corriendo en paralelo (no depende de Gemini).
    const resultado = esAudio
      ? await (async () => {
          const textoTranscrito = await this.gemini.transcribirAudio(file.buffer, mimeType);
          const resultadoFinal = await this.procesarTextoExtraido(
            textoTranscrito,
            usuarioId,
            origen,
            true,
            { ext, nombreArchivoFinal, huella: null },
          );
          await subidaStorage;
          return resultadoFinal;
        })()
      : await (async () => {
        const textoTranscrito = await this.gemini.transcribirImagenODocumento(file.buffer, mimeType);
        const resultadoFinal = await this.procesarTextoExtraido(
          textoTranscrito,
          usuarioId,
          origen,
          false,
          { ext, nombreArchivoFinal, huella },
        );
        await subidaStorage; // recién acá hace falta que el upload haya terminado (para archivoInfo)
        return resultadoFinal;
      })();

    await subidaStorage; // por si la rama de audio terminó antes que un upload que no aplica (no-op)
    return resultado;
  }

  // Registro por texto libre en Telegram (RF pendiente del documento de
  // progreso): la persona escribe el gasto en vez de mandar una foto o un
  // audio, ej. "gasté 30 soles en útiles de oficina". Reusa el prompt de
  // extracción de AUDIO (no uno nuevo) porque ya está pensado para lenguaje
  // hablado/coloquial -- exactamente lo mismo que alguien tipeando de forma
  // libre -- y reusa también todo el resto del pipeline (agrupación,
  // matching de proveedor, duplicados, confianza) llamando al mismo método
  // privado que usa procesarArchivoIndividual desde el paso 3 en adelante.
  // Nunca hay archivo/evidencia que subir: no pasa por Storage ni Gemini de
  // transcripción, solo por la extracción de datos.
  async procesarTextoLibre(
    texto: string,
    usuarioId: number,
    origen: 'web' | 'telegram' = 'telegram',
  ) {
    return this.procesarTextoExtraido(texto, usuarioId, origen, true, null, true);
  }

  // Punto de entrada común a partir del paso 3 (extracción con Gemini) para
  // procesarArchivoIndividual (imagen/documento/audio) y procesarTextoLibre
  // (mensaje de texto). archivoInfo solo aplica cuando esAudio=false (nunca
  // es el caso de texto libre, que siempre entra con esAudio=true para
  // reusar el mismo camino "sin comprobante" que ya usa audio).
  private async procesarTextoExtraido(
    texto: string,
    usuarioId: number,
    origen: 'web' | 'telegram',
    esAudio: boolean,
    archivoInfo: { ext: string; nombreArchivoFinal: string; huella?: string | null } | null,
    esTextoLibre = false,
  ) {
    // 3. Extraer datos estructurados con Gemini (prompt distinto si es audio)
    const datosExtraidos = await this.gemini.extraerFactura(texto, esAudio);
    return this.procesarDatosExtraidos(datosExtraidos, usuarioId, origen, esAudio, archivoInfo, esTextoLibre);
  }

  // Punto de entrada común a partir del paso 4 (normalizar), usado por
  // procesarTextoExtraido para todos los casos (audio, texto libre, e imagen/
  // documento desde que se revirtió el atajo de "una sola llamada a Gemini",
  // ver nota en gemini.service.ts extraerFacturaDeImagen).
  private async procesarDatosExtraidos(
    datosExtraidos: FacturaExtraida,
    usuarioId: number,
    origen: 'web' | 'telegram',
    esAudio: boolean,
    archivoInfo: { ext: string; nombreArchivoFinal: string; huella?: string | null } | null,
    esTextoLibre = false,
  ) {
    // 4. Normalizar (fecha, items) igual que "Separar articulos1"
    const factura = normalizarFactura(datosExtraidos);

    // 4b. Solo para texto libre: a diferencia de una foto o un audio (que
    // siempre implican que la persona quiso registrar algo), un mensaje de
    // texto cualquiera ("hola", "gracias") también pasa por acá. Si Gemini
    // no encontró ningún monto, no se registra nada -- se le devuelve el
    // control a Telegram para que responda pidiendo aclaración, en vez de
    // crear un gasto de S/ 0 (decisión tomada en el Paso 25).
    if (esTextoLibre && !((factura.total_factura ?? 0) > 0)) {
      return {
        success: false as const,
        sin_gasto: true as const,
      };
    }

    // 4c. Si la imagen/documento no es un comprobante válido (ej. captura de
    // pantalla de una web, cotización pendiente), no se registra ningún gasto.
    // Solo aplica a imágenes/documentos, no a audio ni texto libre.
    if (!esAudio && !esTextoLibre && !factura.es_documento_valido) {
      return {
        success: false as const,
        no_es_comprobante: true as const,
      };
    }
    const ext = archivoInfo?.ext ?? '';
    const nombreArchivoFinal = archivoInfo?.nombreArchivoFinal ?? '';

    // 5. Heurística de agrupación de evidencias (solo para comprobantes, no
    //    para audio): si el mismo usuario tiene un gasto reciente con el
    //    mismo monto (ej. acaba de mandar la factura y ahora manda el Yape,
    //    o al revés), asumimos que es el mismo gasto y le adjuntamos el
    //    comprobante + evidencia en vez de crear un gasto nuevo. Ver
    //    diagnóstico técnico, sección 3.
    const montoDetectado = factura.total_factura || 0;

    const datosComprobante = {
      tipo: 'factura' as const,
      numero: factura.n_factura || null,
      empresa_emisora: factura.empresa || null,
      subtotal: factura.subtotal,
      igv: factura.igv,
      total: factura.total_factura,
      fecha_documento: factura.fecha,
    };
    const datosEvidencia = {
      tipo: ext === 'pdf' ? 'pdf' : ('imagen' as const),
      storage_path: nombreArchivoFinal,
      origen,
      huella: archivoInfo?.huella ?? null,
    };

    // 5a. Pago (sección 7/8): solo se registra cuando Gemini identificó un
    //    medio de pago claro (captura de Yape/transferencia, o el usuario lo
    //    dijo por audio). Si es una factura sin indicación de pago, no se
    //    inventa nada.
    const datosPago = factura.medio_pago
      ? {
        medio: factura.medio_pago,
        numero_operacion: factura.numero_operacion || null,
        monto: montoDetectado || null,
      }
      : null;

    // A partir de acá (buscar si hay un gasto para agrupar -> insertar) todo
    // corre serializado por usuario (UsuarioLockService). Si dos archivos
    // del mismo usuario llegan casi juntos (ej. factura + captura de Yape
    // mandadas seguidas, o un álbum de fotos), sin este lock ambos podrían
    // leer "no hay gasto con este monto" al mismo tiempo -- ninguno ve
    // todavía el insert del otro -- y terminar como dos gastos separados en
    // vez de agruparse en uno solo. Lo que sí corrió antes (subir a
    // Storage, Gemini) no necesita serializarse, así que queda afuera del
    // lock para no perder paralelismo donde no hace falta.

    // No siempre un archivo agrupable es "otra factura": si lo único que
    // aporta es la captura de un pago (Yape/transferencia, sin número de
    // factura), no debe generar un comprobante nuevo -- solo cuelga la
    // evidencia y el pago del mismo gasto.
    //
    // OJO: no se puede usar solo "trae nombre de empresa" como señal, porque
    // desde que Gemini extrae también el destinatario en capturas de Yape
    // (para no perder ese dato), un Yape suelto también trae "Empresa"
    // rellena. La señal real es el número de factura -- casi ninguna captura
    // de pago lo tiene -- o, en su defecto, que NO se detectó ningún medio
    // de pago (una factura de verdad normalmente no dice "yape"/"efectivo").
    const pareceFactura = Boolean(
      datosComprobante.numero || (!factura.medio_pago && datosComprobante.empresa_emisora),
    );

    const resultado = await this.usuarioLock.runExclusive(usuarioId, async () => {
      const candidato =
        !esAudio && montoDetectado > 0
          ? await this.gastosService.buscarCandidatoParaAgrupar(usuarioId, montoDetectado, {
            traeComprobante: pareceFactura,
            traePago: Boolean(datosPago),
          })
          : null;

      // 5c. Matching de proveedor/categoría (sección 9 de requerimientos):
      //    solo aplica a comprobantes que parecen factura real (con nombre
      //    de empresa emisora, sección 9), no a audio, no a una captura de
      //    pago suelta (el destinatario de un Yape no es necesariamente un
      //    "proveedor" -- puede ser una persona, no un negocio).
      //
      //    Cuando el archivo se agrupa con un gasto propio reciente
      //    (candidato), esto SOLO debe saltarse si ese candidato YA tiene
      //    categoría asignada (ej. orden factura -> Yape: la factura ya
      //    resolvió proveedor/categoría, el Yape que llega después no debe
      //    tocar nada). Si el candidato todavía no tiene categoría (ej.
      //    orden Yape -> factura: el Yape creó el gasto sin proveedor
      //    porque no "parecía factura"), esta es la primera y única
      //    oportunidad de resolverla -- fix del gap documentado en el
      //    Paso 18.2 del progreso, donde ese caso dejaba el gasto sin
      //    proveedor ni categoría para siempre.
      const candidatoSinCategoria = Boolean(candidato) && candidato.categoria_id == null;

      let proveedorId: number | null = null;
      let categoriaId: number | null = null;
      let esPersonalSugerido: boolean | null = null;
      let faltaPreguntarCategoria = false;

      if (!esAudio && pareceFactura && factura.empresa && (!candidato || candidatoSinCategoria)) {
        const empresaIdProveedor = await this.gastosService.obtenerEmpresaIdDeUsuario(usuarioId);
        const proveedor = empresaIdProveedor
          ? await this.proveedoresService.buscarOCrear(factura.empresa, factura.ruc, empresaIdProveedor)
          : null;
        if (proveedor) {
          proveedorId = proveedor.id;
          if (proveedor.categoria_id_sugerida) {
            // Proveedor ya conocido: se aplica la sugerencia directo, sin
            // preguntar (aprendizaje progresivo).
            categoriaId = proveedor.categoria_id_sugerida;
            esPersonalSugerido = proveedor.es_personal_sugerido;
          } else {
            // Proveedor nuevo (o sin sugerencia todavía): Telegram debe
            // preguntar categoría + tipo de gasto, y guardar la respuesta como
            // sugerencia para la próxima vez.
            faltaPreguntarCategoria = true;
          }
        }
      }

      let gastoId: number;
      let vinculadoA: {
        gasto_id: number;
        monto: number;
        comprobante_id: number | null;
        evidencia_id: number | null;
        pago_id: number | null;
      } | null = null;
      let posibleDuplicado: { usuario_nombre: string; nivel: 'alta' | 'media' } | null = null;

      if (candidato) {
        // No siempre el segundo archivo agrupado es "otra factura": si lo
        // único que aporta es la captura de un pago (Yape/transferencia,
        // sin número de factura ni empresa emisora), no debe generar un
        // comprobante nuevo -- solo cuelga la evidencia y el pago del mismo
        // gasto. (pareceFactura ya se calculó arriba, antes del lock, para
        // poder usarse también como filtro en buscarCandidatoParaAgrupar.)
        const { comprobante, evidencia, pago } = await this.gastosService.adjuntarComprobante(
          candidato.id,
          pareceFactura ? datosComprobante : null,
          esAudio ? null : datosEvidencia,
          datosPago,
          pareceFactura ? factura.items : undefined,
        );
        gastoId = candidato.id;

        // El gasto se había creado con otro archivo (p. ej. la captura del Yape,
        // con la fecha del pago). La fecha que vale es la de la factura.
        if (pareceFactura && factura.fecha && factura.fecha !== candidato.fecha) {
          await this.gastosService.actualizarFecha(candidato.id, factura.fecha);
          candidato.fecha = factura.fecha;
        }

        // Fix Paso 18.2: si el candidato no tenía categoría y el bloque de
        // arriba sí pudo resolverla (proveedor ya conocido), se aplica acá
        // mismo -- el gasto ya existe, no pasa por gastosService.crear().
        // Si en cambio falta preguntar (proveedor nuevo), no se hace nada
        // acá: Telegram pregunta con los botones de siempre, usando
        // faltaPreguntarCategoria + proveedorId ya calculados arriba.
        if (candidatoSinCategoria && categoriaId) {
          await this.gastosService.actualizarCategoria(
            candidato.id,
            categoriaId,
            esPersonalSugerido ?? false,
            proveedorId,
            factura.empresa || null,
          );
        }
        // La factura (o el pago) llegó después y se agrupó a un gasto ya creado:
        // recién ahora se conocen su número, RUC u operación, así que se busca
        // duplicado igual que al crear uno (antes se saltaba este caso).
        if (!esAudio && candidato.posible_duplicado_de == null) {
          const numero = pareceFactura ? datosComprobante.numero : null;
          const rucFactura = pareceFactura ? factura.ruc || null : null;
          const operacion = datosPago?.numero_operacion || null;
          const porImagen = await this.gastosService.buscarDuplicadoPorImagen(
            await this.gastosService.huellasDeGasto(candidato.id),
            Number(candidato.monto) || montoDetectado,
            candidato.empresa_id,
            candidato.id,
            numero,
            operacion,
          );
          const propio = porImagen ?? (await this.gastosService.buscarPosibleDuplicadoDelMismoUsuario(usuarioId, candidato.id, numero, rucFactura, operacion));
          const duplicado = propio ?? (await this.gastosService.buscarPosibleDuplicadoEntreUsuarios(
            usuarioId,
            Number(candidato.monto) || montoDetectado,
            candidato.fecha,
            numero,
            proveedorId ?? candidato.proveedor_id,
            rucFactura,
            operacion,
            candidato.empresa_id,
            candidato.id,
          ));
          if (duplicado) {
            await this.gastosService.marcarPosibleDuplicado(candidato.id, duplicado.gasto.id);
            posibleDuplicado = { usuario_nombre: duplicado.usuario_nombre, nivel: duplicado.nivel };
          }
        }
        vinculadoA = {
          gasto_id: candidato.id,
          monto: candidato.monto,
          comprobante_id: comprobante?.id ?? null,
          evidencia_id: evidencia?.id ?? null,
          pago_id: pago?.id ?? null,
        };
      } else {
        // 5b. Guardar el gasto en el esquema nuevo (gastos + comprobante +
        //    evidencia + detalle de items). Si es audio, no hay comprobante
        //    (puede no haber factura física) ni evidencia (el audio no se
        //    sube a Storage) ni items. Tampoco hay comprobante/items si NO
        //    parece factura real (una captura de Yape/transferencia suelta
        //    es solo evidencia + pago, no un comprobante -- ver
        //    definición de pareceFactura arriba).
        // Para audio con archivo subido a Storage: guardar también la
        // evidencia de audio para que sea visible en el panel web.
        const evidenciaAudio =
          esAudio && nombreArchivoFinal
            ? { tipo: 'audio' as const, storage_path: nombreArchivoFinal, origen, huella: null }
            : null;

        const { gasto } = await this.gastosService.crear({
          usuario_id: usuarioId,
          descripcion: factura.empresa || null,
          monto: montoDetectado,
          fecha: factura.fecha,
          confianza: factura.confianza,
          comprobante: esAudio || !pareceFactura ? null : datosComprobante,
          evidencia: esAudio ? evidenciaAudio : datosEvidencia,
          pago: datosPago,
          items: esAudio || !pareceFactura ? undefined : factura.items,
          categoria_id: categoriaId,
          proveedor_id: proveedorId,
          es_personal: esPersonalSugerido ?? undefined,
        });
        gastoId = gasto.id;

        // Detección de duplicados (sección 17): primero contra los propios
        // gastos del usuario (Paso 31 -- "yo mismo ya subí esto", por
        // identificador exacto, sin límite de tiempo), y solo si esa no
        // encuentra nada, contra los de otros usuarios (monto+fecha, con
        // tolerancia). Solo tiene sentido para comprobantes (mismo caso del
        // ejemplo, Yape/foto), no para audio, que no tiene monto confiable
        // para comparar.
        if (!esAudio && montoDetectado > 0) {
          // Primero la señal más fuerte: la misma imagen ya está en otro gasto.
          const porImagen = await this.gastosService.buscarDuplicadoPorImagen(
            archivoInfo?.huella ? [archivoInfo.huella] : [],
            montoDetectado,
            gasto.empresa_id,
            gastoId,
            datosComprobante.numero,
            datosPago?.numero_operacion || null,
          );
          const duplicadoPropio = porImagen ?? await this.gastosService.buscarPosibleDuplicadoDelMismoUsuario(
            usuarioId,
            gastoId,
            datosComprobante.numero,
            factura.ruc || null,
            datosPago?.numero_operacion || null,
          );
          if (duplicadoPropio) {
            await this.gastosService.marcarPosibleDuplicado(gastoId, duplicadoPropio.gasto.id);
            posibleDuplicado = { usuario_nombre: duplicadoPropio.usuario_nombre, nivel: duplicadoPropio.nivel };
          } else {
            const duplicado = await this.gastosService.buscarPosibleDuplicadoEntreUsuarios(
              usuarioId,
              montoDetectado,
              factura.fecha,
              datosComprobante.numero,
              proveedorId,
              factura.ruc || null,
              datosPago?.numero_operacion || null,
              gasto.empresa_id,
              gastoId,
            );
            if (duplicado) {
              await this.gastosService.marcarPosibleDuplicado(gastoId, duplicado.gasto.id);
              posibleDuplicado = { usuario_nombre: duplicado.usuario_nombre, nivel: duplicado.nivel };
            }
          }
        }
      }

      return { gastoId, vinculadoA, posibleDuplicado, proveedorId, faltaPreguntarCategoria };
    });

    const { gastoId, vinculadoA, posibleDuplicado, proveedorId, faltaPreguntarCategoria } = resultado;

    // 6. Respuesta con una forma compatible con la que devolvía el webhook
    //    de n8n (empresa, n_factura, fecha, subtotal, igv, total, items),
    //    más el id del gasto nuevo (útil para armar el mensaje de Telegram
    //    y para el flujo de "adjuntar comprobante después"), más info de
    //    agrupación si aplicó la heurística (para que Telegram confirme).
    return {
      success: true as const,
      mensaje: 'Gasto registrado correctamente',
      gasto_id: gastoId,
      empresa: factura.empresa,
      n_factura: factura.n_factura,
      fecha: factura.fecha,
      subtotal: factura.subtotal,
      igv: factura.igv,
      total: factura.total_factura || 0,
      medio_pago: factura.medio_pago,
      confianza: factura.confianza,
      moneda: factura.moneda,
      items: factura.items,
      // Indica si esto generó un comprobante de verdad en la BD, o si
      // "empresa"/"items" acá arriba son solo lo que Gemini leyó de una
      // captura de pago (Yape/transferencia) sin comprobante propio. El
      // mensaje de Telegram lo usa para no decir "Factura registrada"
      // cuando en realidad solo se guardó evidencia + pago.
      parece_factura: pareceFactura,
      vinculado_a: vinculadoA,
      es_audio: esAudio,
      es_texto_libre: esTextoLibre,
      posible_duplicado: posibleDuplicado,
      proveedor_id: proveedorId,
      falta_categoria: faltaPreguntarCategoria,
      // RF-11: pista en texto libre, sin resolver. TelegramService la
      // resuelve contra los pedidos de la empresa del gasto y, si hay una
      // sola coincidencia, la propone; si hay varias o ninguna, muestra la
      // lista completa. Nunca se asocia automáticamente sin confirmar.
      pedido_mencionado: factura.pedido_mencionado || '',
    };
  }

  // Adjunta un comprobante (foto/PDF) a un gasto YA existente. Usado por el
  // flujo de botones de Telegram: "¿Tienes comprobante? Sí" o
  // "/gastos → Agregar comprobante". A diferencia de procesarArchivoIndividual,
  // acá nunca se crea un gasto nuevo: siempre cuelga del gastoId dado.
  async adjuntarComprobanteAGasto(gastoId: number, file: ArchivoEntrada) {
    const mimeType = file.mimetype || 'application/octet-stream';
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
    };
    const extPorNombre = file.originalname?.includes('.')
      ? file.originalname.split('.').pop()
      : undefined;
    const ext = extPorNombre || extMap[mimeType] || 'bin';
    const nombreArchivo = `telegram_${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;

    // Igual que en procesarArchivoIndividual: si es imagen, se convierte a
    // WebP antes de subir (ahorro de espacio); Gemini sigue leyendo el
    // buffer original más abajo.
    //
    // El upload a Storage sigue corriendo en paralelo con Gemini (son
    // independientes). REVERTIDO el atajo de "una sola llamada" a Gemini
    // (ver nota en gemini.service.ts extraerFacturaDeImagen): volvemos a
    // transcribir + extraer como dos round-trips secuenciales, porque en
    // comprobantes manuscritos perdía precisión (items y fecha).
    const convertida = await convertirImagenAWebp(file.buffer, mimeType);
    const bufferASubir = convertida?.buffer ?? file.buffer;
    const mimeASubir = convertida?.mimetype ?? mimeType;
    const nombreArchivoFinal = convertida
      ? `telegram_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`
      : nombreArchivo;

    const [textoTranscrito] = await Promise.all([
      this.gemini.transcribirImagenODocumento(file.buffer, mimeType),
      this.supabase
        .getClient()
        .storage.from(BUCKET)
        .upload(nombreArchivoFinal, bufferASubir, { contentType: mimeASubir, upsert: true })
        .then(({ error: uploadError }) => {
          if (uploadError) {
            throw new InternalServerErrorException(`Error subiendo el archivo: ${uploadError.message}`);
          }
        }),
    ]);
    const datosExtraidos = await this.gemini.extraerFactura(textoTranscrito, false);
    const factura = normalizarFactura(datosExtraidos);

    const { comprobante, pago } = await this.gastosService.adjuntarComprobante(
      gastoId,
      {
        tipo: 'factura',
        numero: factura.n_factura || null,
        empresa_emisora: factura.empresa || null,
        subtotal: factura.subtotal,
        igv: factura.igv,
        total: factura.total_factura,
        fecha_documento: factura.fecha,
      },
      {
        tipo: ext === 'pdf' ? 'pdf' : 'imagen',
        storage_path: nombreArchivoFinal,
        origen: 'telegram',
        huella: await huellaImagen(file.buffer, mimeType),
      },
      factura.medio_pago
        ? {
          medio: factura.medio_pago,
          numero_operacion: factura.numero_operacion || null,
          monto: factura.total_factura || null,
        }
        : null,
      factura.items,
    );

    return { comprobante, pago, factura };
  }

}