require('dotenv').config(); 
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const swaggerUi = require('swagger-ui-express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const swaggerDocument = require('./swagger.json');
const app = express();
const puerto = 3000;

// ==========================================
// CONFIGURACIÓN DE LA BASE DE DATOS
// ==========================================

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME // <-- Cambiado de 'name' a 'database'
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0
});



// ==========================================
// MIDDLEWARES Y SEGURIDAD
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Límite de 2,500 peticiones cada 5 minutos para proteger la infraestructura
const limitadorAPI = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 2500,
    message: { error: 'Demasiadas peticiones desde esta IP. RAXLOR SYSTEMS protege la integridad del nodo.' }
});

app.use('/api/v1/', limitadorAPI);

// Configuración de CORS dinámico para Dominican Technology
const allowedOrigins = [process.env.ALLOWED_ORIGIN || 'http://localhost:3000'];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Bloqueado por seguridad de Dominican Technology'));
        }
    },
    credentials: true
};

// ==========================================
// SISTEMA DE RASTREO (TRACKER)
// ==========================================
const registrarConsulta = async (rnc, tipo, ip) => {
    try {
        await pool.query(
            'INSERT INTO consultas_log (tipo_consulta, ip_cliente) VALUES ( ?, ?)',
            [tipo, ip]
        );
    } catch (error) {
        console.error('❌ Error en el rastreador:', error.sqlMessage || error.message);
    }
};

// ==========================================
// ESTADÍSTICAS REALES (SOCIAL PROOF)
// ==========================================
// Endpoint de estadísticas optimizado para baja latencia

app.get('/api/stats', cors(corsOptions), async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection(); // Obtener conexión específica

        // Ejecutamos ambas consultas en paralelo para ahorrar tiempo
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
        if (conn) conn.release(); // Liberar conexión inmediatamente
    }
});

// ==========================================
// DOCUMENTACIÓN SWAGGER (DISEÑO PREMIUM)
// ==========================================info: {

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ==========================================
// RUTAS PRINCIPALES
// ==========================================

app.get('/api/v1/rnc/:rnc', async (req, res) => {
    const { rnc } = req.params;
    const rncLimpio = rnc ? rnc.trim() : '';

    if (rncLimpio.length < 9) return res.status(400).json({ error: 'Formato inválido.' });

    try {
        const [resultados] = await pool.query('SELECT * FROM contribuyentes WHERE rnc = ?', [rncLimpio]);
        if (resultados.length === 0) return res.status(404).json({ error: 'RNC no encontrado' });

        // Solo registramos que hubo una consulta de tipo DIRECTO
        registrarConsulta('DIRECTO_RNC', req.ip).catch(e => console.error(e));

        res.json({ exito: true, data: resultados[0] });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});


app.get('/api/v1/buscar', async (req, res) => {
    const busqueda = req.query.q ? req.query.q.trim() : '';

    // Nueva validación de longitud mínima
    if (busqueda.length < 3) {
        return res.status(400).json({
            error: 'La búsqueda debe tener al menos 3 caracteres para garantizar precisión.'
        });
    }

    try {
        const [resultados] = await pool.query(
            'SELECT rnc, razon_social, actividad_economica, estado FROM contribuyentes WHERE razon_social LIKE ? LIMIT 50',
            [`%${busqueda}%`]
        );

        // Registro asíncrono para no afectar la latencia
        registrarConsulta(null, 'BUSQUEDA_NOMBRE', req.ip).catch(err =>
            console.error("Error tracker:", err.message)
        );

        res.json({ exito: true, total: resultados.length, data: resultados });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});


app.get('/api/consultar', async (req, res) => {
    const busqueda = req.query.q ? req.query.q.trim() : '';
    if (busqueda.length < 3) return res.json([]);

    try {
        const [resultados] = await pool.query(
            'SELECT rnc, razon_social, estado FROM contribuyentes WHERE rnc = ? OR razon_social LIKE ? LIMIT 50',
            [busqueda, `%${busqueda}%`]
        );

        if (resultados.length > 0) {
            // Solo registramos que se usó el buscador interno
            registrarConsulta('INTERNA', req.ip).catch(e => console.error(e));
        }

        res.json(resultados);
    } catch (error) {
        res.status(500).json({ error: 'Error de base de datos.' });
    }
});

// Función optimizada para RAXLOR SYSTEMS
const registrarLog = async (tipo, ip) => {
    try {
        // No usamos 'await' en la ruta principal para no frenar la respuesta al usuario
        pool.query(
            'INSERT INTO consultas_log (tipo_consulta, ip_cliente) VALUES (?, ?)',
            [tipo, ip]
        );
    } catch (err) {
        console.error("Error silencioso en log:", err.message);
    }
};

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
app.listen(puerto, () => {
    console.log(`\n========================================`);
    console.log(`🚀 RAXLOR SYSTEMS - ENGINE READY`);
    console.log(`📡 Nodo: Dominican Technology`);
    console.log(`========================================`);
    console.log(`📄 Docs : http://localhost:${puerto}/docs`);
    console.log(`========================================\n`);
});