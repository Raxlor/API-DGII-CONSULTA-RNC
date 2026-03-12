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
const registrarConsulta = async (tipo, ip) => {
    try {
        // Ajustado para coincidir con el INSERT de 2 columnas que tienes
        await pool.query(
            'INSERT INTO consultas_log (tipo_consulta, ip_cliente) VALUES (?, ?)',
            [tipo, ip]
        );
    } catch (error) {
        console.error('❌ Error en el rastreador:', error.sqlMessage || error.message);
    }
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

        const totalConsultas = (queries[0][0]?.total || 0) + 39000;
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

        registrarConsulta('DIRECTO_RNC', req.ip).catch(e => console.error(e));

        res.json({ exito: true, data: resultados[0] });
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

        registrarConsulta('BUSQUEDA_NOMBRE', req.ip).catch(err => console.error("Error tracker:", err.message));

        res.json({ exito: true, total: resultados.length, data: resultados });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Swagger Docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Sitemap
app.get('/sitemap.xml', async (req, res) => {
    try {
        const stream = new SitemapStream({ hostname: 'https://api-dgii.dominicantechnology.com' });
        const links = [
            { url: '/', changefreq: 'daily', priority: 1.0 },
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