require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const swaggerUi = require('swagger-ui-express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const swaggerDocument = require('./swagger.json');
const { SitemapStream, streamToPromise } = require('sitemap');
const { Readable } = require('stream');
const { url } = require('inspector');
const { log } = require('console');

const app = express();
const puerto = process.env.PORT || 3000;

// ==========================================
// CONFIGURACIÓN DE SEGURIDAD PROXY (CRÍTICO)
// ==========================================
// Esto soluciona el error ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

// ==========================================
// CONFIGURACIÓN DE LA BASE DE DATOS
// ==========================================
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0
});

// ==========================================
// MIDDLEWARES GENERALES
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// CORS Global Inicial
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Límite de peticiones para proteger la infraestructura de RAXLOR SYSTEMS
const limitadorAPI = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 2500,
    message: { error: 'Demasiadas peticiones desde esta IP. RAXLOR SYSTEMS protege la integridad del nodo.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/v1/', limitadorAPI);

// ==========================================
// SISTEMA DE RASTREO (TRACKER)
// ==========================================
const registrarConsulta = async (tipo, ip, query = null) => {
    try {
        await pool.query(
            'INSERT INTO consultas_log (tipo_consulta, ip_cliente, query) VALUES (?, ?, ?)',
            [tipo, ip, query]
        );
    } catch (error) {
        console.error('❌ Error en el rastreador:', error.sqlMessage || error.message);
    }
};

const extraerCampo = (html, nombre) => {
    const regex = new RegExp(`id=["']${nombre}["'][^>]*value=["']([\\s\\S]*?)["']`, 'i');
    const match = html.match(regex);
    return match ? match[1] : '';
};

const decodificarHtml = (texto = '') => {
    return texto
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
};

const limpiarTextoHtml = (html = '') => {
    const sinTags = html.replace(/<[^>]+>/g, ' ');
    return decodificarHtml(sinTags).replace(/\s+/g, ' ').trim();
};

const extraerTbRowComoJson = (html = '') => {
    const filas = [];
    const regexFila = /<tr[^>]*class=["'][^"']*TbRow[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
    let matchFila;

    while ((matchFila = regexFila.exec(html)) !== null) {
        const bloqueFila = matchFila[1];
        const regexCeldas = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const celdas = [];
        let matchCelda;

        while ((matchCelda = regexCeldas.exec(bloqueFila)) !== null) {
            celdas.push(limpiarTextoHtml(matchCelda[1]));
        }

        if (celdas.length > 0) {
            filas.push({
                rnc: celdas[0].replaceAll('-', '') || null, // para extandarizar con mis otra consulta
                razon_social: celdas[1] || null,
                nombre_comercial: celdas[2] || null,
                actividad_economica: celdas[3] || null,  /// es categoria pero en este caso no se muestra en la consulta de la DGII, se muestra como actividad economica, para estandarizar con mi otra consulta
                Regimen_de_pagos: celdas[4] || null,
                estado: celdas[5] || null,
                Facturador_Electronico: celdas[6] || null,
                Licencias_de_Comercialización_de_VHM: celdas[7] || null
            });
        }
    }
   
    return filas;
};

// ==========================================
// RUTAS Y ENDPOINTS
// ==========================================

// Estadísticas para Social Proof
app.get('/api/stats', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const [queries, entities] = await Promise.all([
            conn.query('SELECT COUNT(*) as total FROM consultas_log'),
            conn.query('SELECT COUNT(*) as total FROM contribuyentes')
        ]);

        const totalConsultas = (queries[0][0]?.total || 0);
        const totalEmpresas = entities[0][0]?.total || 0;

        res.json({
            exito: true,
            total_consultas: totalConsultas,
            total_empresas: totalEmpresas
        });
    } catch (error) {
        console.error('Error en Stats:', error);
        res.status(500).json({ exito: false });
    } finally {
        if (conn) conn.release();
    }
});

// Consulta Directa RNC
app.get('/api/v1/rnc/:rnc', async (req, res) => {
    const { rnc } = req.params;
    const rncLimpio = rnc ? rnc.trim() : '';

    if (rncLimpio.length < 9) return res.status(400).json({ error: 'Formato inválido.' });

    try {
        const [resultados] = await pool.query('SELECT * FROM contribuyentes WHERE rnc = ?', [rncLimpio]);
        if (resultados.length === 0) return res.status(404).json({ error: 'RNC no encontrado' });

        registrarConsulta('DIRECTO_RNC', req.ip, rncLimpio).catch(e => console.error(e));

        res.json({ exito: true, fuente: "Interna", data: resultados[0] });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Buscador por Nombre
app.get('/api/v1/buscar', async (req, res) => {
    const busqueda = req.query.q ? req.query.q.trim() : '';
    if (busqueda.length < 3) {
        return res.status(400).json({ error: 'La búsqueda requiere al menos 3 caracteres.' });
    }

    try {
        const [resultados] = await pool.query(
            'SELECT rnc, razon_social, actividad_economica, estado FROM contribuyentes WHERE razon_social LIKE ? LIMIT 50',
            [`%${busqueda}%`]
        );

        registrarConsulta('BUSQUEDA_NOMBRE', req.ip, busqueda).catch(err => console.error("Error tracker:", err.message));

        res.json({ exito: true, fuente: "Interna", total: resultados.length, data: resultados });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});
app.get('/api/v1/buscardgi/', async (req, res) => {
    const busqueda = req.query.q ? req.query.q.trim() : '';
    if (busqueda.length < 3) {
        return res.status(400).json({ error: 'La búsqueda requiere al menos 3 caracteres.' });
    }

    const url = 'https://dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/rnc.aspx';
    const headersNavegador = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
    };

    try {
        // 1. GET Inicial para obtener la sesión y los tokens de ASP.NET
        const getRes = await fetch(url, { headers: headersNavegador });
        const htmlBase = await getRes.text();
        const cookiesSesion = getRes.headers.get('set-cookie') || '';

        // Extraer los 3 pilares de WebForms usando nuestra función RegEx
        const vs = extraerCampo(htmlBase, '__VIEWSTATE');
        const vsg = extraerCampo(htmlBase, '__VIEWSTATEGENERATOR');
        const ev = extraerCampo(htmlBase, '__EVENTVALIDATION');

        // 2. Construir el cuerpo del POST (Exactamente como lo espera el servidor)
        const params = new URLSearchParams();
        params.append('ctl00$smMain', 'ctl00$cphMain$upBusqueda|ctl00$cphMain$btnBuscarPorRazonSocial');
        params.append('__EVENTTARGET', '');
        params.append('__EVENTARGUMENT', '');
        params.append('__VIEWSTATE', vs);
        params.append('__VIEWSTATEGENERATOR', vsg);
        params.append('__EVENTVALIDATION', ev);
        params.append('ctl00$cphMain$txtRazonSocial', busqueda);
        params.append('ctl00$cphMain$hidActiveTab', 'razonsocial');
        params.append('__ASYNCPOST', 'true');
        params.append('ctl00$cphMain$btnBuscarPorRazonSocial', 'Buscar');

        // 3. POST de búsqueda
        const postRes = await fetch(url, {
            method: 'POST',
            headers: {
                ...headersNavegador,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-MicrosoftAjax': 'Delta=true',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': cookiesSesion,
            },
            body: params.toString()
        });

        const respuestaRaw = await postRes.text();


        if (!postRes.ok) {
            return res.status(502).json({
                error: 'DGII devolvió un error.',
                status: postRes.status,
                detalles: respuestaRaw.slice(0, 500)
            });
        }

        const resultados = extraerTbRowComoJson(respuestaRaw);
        registrarConsulta('BUSQUEDA_DGII', req.ip, busqueda).catch(err => console.error('Error tracker:', err.message));

        return res.json({
            exito: true,
            fuente: 'DGII',
            total: resultados.length,
            data: resultados,

        });

    } catch (error) {
        return res.status(500).json({ error: 'Error de conexión', detalles: error.message });
    }
});

/// funcion fuctura actualizacion con cada consulta si y solo si existe y existen cambios, visible actualizar en la base de datos

// Swagger Docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    customSiteTitle: 'Documentacion API RNC Republica Dominicana',
    customfavIcon: '/Logo.png',
    customJs: '/swagger-custom.js'
}));

// Ruta SEO-friendly para documentacion
app.get('/documentacion', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'documentacion.html'));
});

// Sitemap
app.get('/sitemap.xml', async (req, res) => {
    try {
        const stream = new SitemapStream({ hostname: 'https://api-dgii.dominicantechnology.com' });
        const links = [
            { url: '/', changefreq: 'daily', priority: 1.0 },
            { url: '/documentacion', changefreq: 'daily', priority: 0.95 },
            { url: '/docs', changefreq: 'weekly', priority: 0.9 }
        ];
        res.header('Content-Type', 'application/xml');
        const xml = await streamToPromise(Readable.from(links).pipe(stream));
        res.send(xml.toString());
    } catch (error) {
        res.status(500).send('Error sitemap');
    }
});

app.listen(puerto, () => {
    console.log(`🚀 RAXLOR SYSTEMS - ENGINE READY`);
    console.log(`📡 Nodo: Dominican Technology`);
    console.log(`📄 Docs : http://localhost:${puerto}/docs`);
});