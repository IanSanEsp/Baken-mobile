const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
// dotenv no se usa en Railway (las variables se inyectan directamente por la plataforma)
// require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS — permite cualquier origen (browser, APK Capacitor, etc.)
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.options('*', cors());
app.use(express.json());

const dbConfig = {
    host:               process.env.DB_HOST,
    user:               process.env.DB_USER,
    password:           process.env.DB_PASSWORD,
    database:           process.env.DB_NAME,
    port:               parseInt(process.env.DB_PORT) || 3306,
    multipleStatements: true,
    connectTimeout:     30000
};

let pool;

async function connectDB() {
    try {
        pool = mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 10 });
        const conn = await pool.getConnection();
        console.log(`Conectado → ${dbConfig.host}/${dbConfig.database}`);
        conn.release();
        return true;
    } catch (e) {
        console.error('Error conectando a MySQL:', e.message);
        console.error('  Host:', dbConfig.host, '| Puerto:', dbConfig.port, '| BD:', dbConfig.database);
        return false;
    }
}

function obtenerBloqueActual() {
    const ahora = new Date();
    const hm = ahora.getHours() * 60 + ahora.getMinutes();
    const bloques = [
        [1,  7*60,  7*60+50], [2,  8*60,  8*60+50], [3,  9*60,  9*60+50],
        [4, 10*60, 10*60+50], [5, 11*60, 11*60+50], [6, 12*60, 12*60+50],
        [7, 13*60, 13*60+50], [8, 14*60, 14*60+50], [9, 15*60, 15*60+50],
        [10,16*60, 16*60+50], [11,17*60, 17*60+50], [12,18*60, 18*60+50],
        [13,19*60, 19*60+50], [14,20*60, 20*60+50]
    ];
    for (const [id, ini, fin] of bloques) {
        if (hm >= ini && hm <= fin) return id;
    }
    return null;
}

// ─── Login móvil (Alumno + Profesor) ─────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    if (!correo || !contrasena)
        return res.status(400).json({ success: false, message: 'Faltan credenciales' });
    try {
        // Intentar como Alumno
        let [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo, u.turno,
                    tu.nombre_tipo AS tipo_usuario,
                    g.id_grupo, g.nombre_grupo AS grupo, g.semestre, g.turno AS grupo_turno
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT JOIN Grupos g ON g.id_grupo = u.id_grupo
             WHERE u.correo = ? AND u.contraseña = ? AND tu.nombre_tipo = 'Alumno'`,
            [correo, contrasena]
        );
        if (rows.length > 0) {
            const a = rows[0];
            return res.json({ success: true, message: 'Login exitoso', usuario: {
                id: a.boleta, nombre: a.nombre, correo: a.correo, boleta: a.boleta,
                tipo_usuario: 'Alumno',
                grupo: a.grupo || 'Sin grupo', id_grupo: a.id_grupo || null,
                semestre: a.semestre || 1, turno: a.grupo_turno || 'No asignado'
            }});
        }

        // Intentar como Profesor
        [rows] = await pool.execute(
            `SELECT u.id_usuarios, u.nombre, u.correo,
                    tu.nombre_tipo AS tipo_usuario
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             INNER JOIN Profesores p    ON p.id_profesor      = u.id_usuarios
             WHERE u.correo = ? AND u.contraseña = ? AND tu.nombre_tipo = 'Profesor'`,
            [correo, contrasena]
        );
        if (rows.length > 0) {
            const p = rows[0];
            return res.json({ success: true, message: 'Login exitoso', usuario: {
                id: p.id_usuarios, nombre: p.nombre, correo: p.correo,
                boleta: p.id_usuarios,
                tipo_usuario: 'Profesor'
            }});
        }

        return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Login Web (Prefecto / Profesor) ─────────────────────────────────────
app.post('/api/login/web', async (req, res) => {
    const { correo, contrasena } = req.body;
    if (!correo || !contrasena)
        return res.status(400).json({ success: false, message: 'Faltan credenciales' });
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios, u.nombre, u.correo, u.turno,
                    tu.nombre_tipo AS tipo_usuario,
                    g.id_grupo, g.nombre_grupo, g.semestre
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT JOIN Grupos g ON g.id_grupo = u.id_grupo
             WHERE u.correo = ? AND u.contraseña = ?
               AND tu.nombre_tipo IN ('Prefecto General','Prefecto de Piso','Profesor','Auxiliar')`,
            [correo, contrasena]
        );
        if (rows.length === 0)
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas o tipo de usuario no permitido' });
        const u = rows[0];
        res.json({ success: true, usuario: {
            id: u.id_usuarios, nombre: u.nombre, correo: u.correo, turno: u.turno,
            tipo_usuario: u.tipo_usuario,
            id_grupo: u.id_grupo || null, grupo: u.nombre_grupo || null, semestre: u.semestre || null
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Info alumno por boleta ─────────────────────────────────────────────────
app.get('/api/alumno/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo, u.turno,
                    tu.nombre_tipo AS tipo_usuario,
                    u.id_grupo,
                    g.nombre_grupo AS grupo, g.semestre, g.turno AS grupo_turno
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT JOIN Grupos g ON g.id_grupo = u.id_grupo
             WHERE u.id_usuarios = ?`, [req.params.boleta]
        );
        if (rows.length === 0)
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        res.json({ success: true, alumno: rows[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horario por grupo (POST) — FIJO via horarios ──────────────────────────
app.post('/api/horario', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    m.nombre_materia AS materia,
                    u.nombre AS profesor_nombre,
                    s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS salon_tipo
             FROM Horario_Fijo hf
             INNER JOIN horarios   hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Materias   m   ON m.id_materia        = hf.id_materia
             INNER JOIN Profesores p   ON p.id_profesor       = hf.id_profesor
             INNER JOIN Usuarios   u   ON u.id_usuarios       = p.id_profesor
             LEFT  JOIN Salones    s   ON s.id_salon           = hf.id_salon
             LEFT  JOIN tipo_salon ts  ON ts.id_tipo_salon     = s.tipo_salon
             WHERE hor.id_grupo = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [req.body.grupo]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Salones por piso ───────────────────────────────────────────────────────
app.get('/api/salones/piso/:piso', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado
             FROM Salones s
             LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE s.piso = ? ORDER BY s.nombre_salon`,
            [req.params.piso]
        );
        res.json({ success: true, salones: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Todos los salones ──────────────────────────────────────────────────────
app.get('/api/salones', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado
             FROM Salones s
             LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             ORDER BY s.piso, s.nombre_salon`
        );
        res.json({ success: true, salones: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Grupos por semestre y turno ───────────────────────────────────────────
app.get('/api/grupos/:semestre/:turno', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id_grupo, nombre_grupo, semestre, area_estudio, turno
             FROM Grupos WHERE semestre = ? AND turno = ? ORDER BY nombre_grupo`,
            [parseInt(req.params.semestre), req.params.turno]
        );
        res.json({ success: true, grupos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Todos los grupos de un semestre (ambos turnos) ───────────────────────
app.get('/api/grupos/semestre/:semestre', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id_grupo, nombre_grupo, semestre, area_estudio, turno
             FROM Grupos WHERE semestre = ? ORDER BY turno, nombre_grupo`,
            [parseInt(req.params.semestre)]
        );
        res.json({ success: true, grupos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Todos los profesores ───────────────────────────────────────────────────
app.get('/api/profesores', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS id_profesor, u.nombre, u.correo,
                    p.area_educacion, p.estado_asistencia
             FROM Usuarios u
             INNER JOIN Profesores p    ON p.id_profesor      = u.id_usuarios
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario  = u.tipo_usuario
             WHERE tu.nombre_tipo = 'Profesor' ORDER BY u.nombre`
        );
        res.json({ success: true, profesores: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Estadísticas ──────────────────────────────────────────────────────────
app.get('/api/estadisticas', async (req, res) => {
    try {
        const [[grupos]]     = await pool.execute('SELECT COUNT(*) AS total FROM Grupos');
        const [[salones]]    = await pool.execute('SELECT COUNT(*) AS total FROM Salones');
        const [[profesores]] = await pool.execute('SELECT COUNT(*) AS total FROM Profesores');
        const [[alumnos]]    = await pool.execute(
            `SELECT COUNT(*) AS total FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             WHERE tu.nombre_tipo = 'Alumno'`
        );
        res.json({ success: true, estadisticas: {
            grupos: grupos.total, salones: salones.total,
            profesores: profesores.total, alumnos: alumnos.total
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Buscar salones ────────────────────────────────────────────────────────
app.post('/api/salones/buscar', async (req, res) => {
    const { nombre, piso, disponibilidad, tipo } = req.body;
    try {
        let q = `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                        ts.nombre_tipo_salon AS tipo, s.estado
                 FROM Salones s LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon WHERE 1=1`;
        const p = [];
        if (nombre)                                    { q += ` AND s.nombre_salon LIKE ?`;       p.push(`%${nombre}%`); }
        if (piso !== undefined && piso !== '')         { q += ` AND s.piso = ?`;                  p.push(String(piso)); }
        if (disponibilidad && disponibilidad !== 'Todos') { q += ` AND s.estado = ?`;             p.push(disponibilidad); }
        if (tipo && tipo !== 'Todos')                  { q += ` AND ts.nombre_tipo_salon = ?`;    p.push(tipo); }
        q += ` ORDER BY s.piso, s.nombre_salon`;
        const [rows] = await pool.execute(q, p);
        res.json({ success: true, salones: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Buscar grupos ────────────────────────────────────────────────────────
app.post('/api/grupos/buscar', async (req, res) => {
    const { nombre, semestre, turno } = req.body;
    try {
        let q = `SELECT id_grupo, nombre_grupo, semestre, area_estudio, turno FROM Grupos WHERE 1=1`;
        const p = [];
        if (nombre)                                    { q += ` AND nombre_grupo LIKE ?`; p.push(`%${nombre}%`); }
        if (semestre !== undefined && semestre !== '') { q += ` AND semestre = ?`;        p.push(parseInt(semestre)); }
        if (turno && turno !== 'Todos')                { q += ` AND turno = ?`;           p.push(turno); }
        q += ` ORDER BY semestre, nombre_grupo`;
        const [rows] = await pool.execute(q, p);
        res.json({ success: true, grupos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horario de grupo (GET) — via horarios ────────────────────────────────
app.get('/api/horario/grupo/:id_grupo', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_materia, hf.id_profesor, hf.id_salon,
                    m.nombre_materia AS materia,
                    u.nombre AS profesor_nombre,
                    s.nombre_salon AS numero_salon, s.piso
             FROM Horario_Fijo hf
             INNER JOIN horarios   hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Materias   m   ON m.id_materia        = hf.id_materia
             INNER JOIN Profesores p   ON p.id_profesor       = hf.id_profesor
             INNER JOIN Usuarios   u   ON u.id_usuarios       = p.id_profesor
             LEFT  JOIN Salones    s   ON s.id_salon           = hf.id_salon
             WHERE hor.id_grupo = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [req.params.id_grupo]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horario completo de un profesor ─────────────────────────────────────────
app.get('/api/horario/profesor/:id_profesor', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_materia, hf.id_profesor, hf.id_salon,
                    m.nombre_materia AS materia,
                    hor.id_grupo, g.nombre_grupo,
                    s.nombre_salon AS numero_salon, s.piso
             FROM Horario_Fijo hf
             INNER JOIN horarios   hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Materias   m   ON m.id_materia        = hf.id_materia
             INNER JOIN Grupos     g   ON g.id_grupo          = hor.id_grupo
             LEFT  JOIN Salones    s   ON s.id_salon          = hf.id_salon
             WHERE hf.id_profesor = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [req.params.id_profesor]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horario de salón hoy ─────────────────────────────────────────────────
app.get('/api/horario/salon/:id_salon', async (req, res) => {
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const diaActual = dias[new Date().getDay()];
    try {
        const [rows] = await pool.execute(
            `SELECT hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    m.nombre_materia AS materia,
                    h.id_grupo, g.nombre_grupo,
                    u.nombre AS profesor_nombre
             FROM Horario_Fijo hf
             INNER JOIN horarios   h   ON h.id_horario_fijo   = hf.id_horario_fijo
             INNER JOIN Grupos     g   ON g.id_grupo           = h.id_grupo
             INNER JOIN Materias   m   ON m.id_materia         = hf.id_materia
             INNER JOIN Profesores p   ON p.id_profesor        = hf.id_profesor
             INNER JOIN Usuarios   u   ON u.id_usuarios        = p.id_profesor
             WHERE hf.id_salon = ? AND hf.dia = ?
             ORDER BY hf.hora_inicio`,
            [req.params.id_salon, diaActual]
        );
        res.json({ success: true, horario: rows, dia: diaActual });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horario semana completa de un salón ──────────────────────────────────
app.get('/api/horario/salon/:id_salon/semana', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_materia, hf.id_profesor,
                    h.id_grupo,
                    g.nombre_grupo,
                    m.nombre_materia,
                    u.nombre AS profesor_nombre
             FROM Horario_Fijo hf
             INNER JOIN horarios   h ON h.id_horario_fijo  = hf.id_horario_fijo
             INNER JOIN Grupos     g ON g.id_grupo          = h.id_grupo
             INNER JOIN Materias   m ON m.id_materia        = hf.id_materia
             INNER JOIN Profesores p ON p.id_profesor       = hf.id_profesor
             INNER JOIN Usuarios   u ON u.id_usuarios       = p.id_profesor
             WHERE hf.id_salon = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [req.params.id_salon]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Dashboard: salones de un piso con ocupante actual ────────────────────
app.get('/api/dashboard/piso/:piso', async (req, res) => {
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const dia   = req.query.dia    || dias[new Date().getDay()];
    const bloque = req.query.bloque ? parseInt(req.query.bloque) : (obtenerBloqueActual() ?? 0);

    try {
        const [rows] = await pool.execute(
            `SELECT
               s.id_salon, s.nombre_salon AS numero_salon, s.piso, s.estado,
               ts.nombre_tipo_salon AS tipo,
               hf.id_horario_fijo_detalle, hf.id_horario_fijo,
               hf.id_materia, hf.id_profesor,
               hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
               h.id_grupo,
               g.nombre_grupo,
               m.nombre_materia,
               u.nombre AS profesor_nombre
             FROM Salones s
             LEFT JOIN tipo_salon ts  ON ts.id_tipo_salon   = s.tipo_salon
             LEFT JOIN Horario_Fijo hf ON hf.id_salon = s.id_salon
                                       AND hf.dia = ?
                                       AND hf.bloque_horario = ?
             LEFT JOIN horarios h     ON h.id_horario_fijo  = hf.id_horario_fijo
             LEFT JOIN Grupos g       ON g.id_grupo          = h.id_grupo
             LEFT JOIN Materias m     ON m.id_materia        = hf.id_materia
             LEFT JOIN Profesores p   ON p.id_profesor       = hf.id_profesor
             LEFT JOIN Usuarios u     ON u.id_usuarios       = p.id_profesor
             WHERE s.piso = ?
             ORDER BY s.nombre_salon`,
            [dia, bloque, req.params.piso]
        );

        // Eliminar duplicados por salon (por si hubiese conflicto de datos)
        const vistos = new Set();
        const salones = rows.filter(r => {
            if (vistos.has(r.id_salon)) return false;
            vistos.add(r.id_salon);
            return true;
        }).map(r => ({
            id_salon:      r.id_salon,
            numero_salon:  r.numero_salon,
            piso:          String(r.piso),
            estado:        r.estado,
            tipo:          r.tipo,
            ocupante: r.id_grupo ? {
                id_grupo:        r.id_grupo,
                nombre_grupo:    r.nombre_grupo,
                id_materia:      r.id_materia,
                nombre_materia:  r.nombre_materia,
                id_profesor:     r.id_profesor,
                profesor_nombre: r.profesor_nombre,
                hora_inicio:     r.hora_inicio,
                hora_fin:        r.hora_fin,
                bloque_horario:  r.bloque_horario,
                id_horario_fijo_detalle: r.id_horario_fijo_detalle
            } : null
        }));

        res.json({ success: true, salones, dia, bloque });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horarios completos de un semestre ────────────────────────────────────
app.get('/api/horarios/completo/:semestre', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT
               hf.id_horario_fijo_detalle, hf.id_horario_fijo,
               hf.id_materia, hf.id_profesor, hf.id_salon,
               hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
               h.id_grupo,
               g.nombre_grupo, g.area_estudio, g.turno AS turno_grupo,
               m.nombre_materia,
               u.nombre AS profesor_nombre,
               s.nombre_salon AS numero_salon, s.piso
             FROM Horario_Fijo hf
             INNER JOIN horarios   h ON h.id_horario_fijo  = hf.id_horario_fijo
             INNER JOIN Grupos     g ON g.id_grupo          = h.id_grupo
             INNER JOIN Materias   m ON m.id_materia        = hf.id_materia
             INNER JOIN Profesores p ON p.id_profesor       = hf.id_profesor
             INNER JOIN Usuarios   u ON u.id_usuarios       = p.id_profesor
             LEFT  JOIN Salones    s ON s.id_salon           = hf.id_salon
             WHERE g.semestre = ?
             ORDER BY g.nombre_grupo,
                      FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'),
                      hf.hora_inicio`,
            [parseInt(req.params.semestre)]
        );
        res.json({ success: true, horarios: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Todas las materias ───────────────────────────────────────────────────
app.get('/api/materias', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id_materia, nombre_materia, semestre, area_estudio
             FROM Materias ORDER BY nombre_materia`
        );
        res.json({ success: true, materias: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Registrar incidencia ─────────────────────────────────────────────────
app.post('/api/incidencias', async (req, res) => {
    const { id_profesor, id_grupo, accion_tomada, hora, fecha } = req.body;
    if (!id_profesor || !id_grupo || !accion_tomada)
        return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
    try {
        const fechaUso = fecha || new Date().toISOString().split('T')[0];
        const horaUso  = hora  || new Date().toTimeString().substring(0, 8);
        const [result] = await pool.execute(
            `INSERT INTO Incidencias (fecha, hora, id_profesor, id_grupo, accion_tomada)
             VALUES (?, ?, ?, ?, ?)`,
            [fechaUso, horaUso, id_profesor, id_grupo, accion_tomada]
        );
        res.json({ success: true, id: result.insertId, message: 'Incidencia registrada' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Incidencias recientes ────────────────────────────────────────────────
app.get('/api/incidencias/recientes', async (req, res) => {
    const limite = parseInt(req.query.limite) || 30;
    try {
        const [rows] = await pool.execute(
            `SELECT i.id_ausencia, i.fecha, i.hora, i.accion_tomada,
                    i.id_profesor, i.id_grupo,
                    u.nombre AS profesor_nombre,
                    g.nombre_grupo,
                    s.id_salon, s.nombre_salon AS numero_salon, s.piso
             FROM Incidencias i
             INNER JOIN Profesores p ON p.id_profesor = i.id_profesor
             INNER JOIN Usuarios   u ON u.id_usuarios = p.id_profesor
             INNER JOIN Grupos     g ON g.id_grupo    = i.id_grupo
             LEFT JOIN Horario_Fijo hf ON hf.id_profesor = i.id_profesor
             LEFT JOIN horarios    h  ON h.id_horario_fijo = hf.id_horario_fijo
                                      AND h.id_grupo = i.id_grupo
             LEFT JOIN Salones     s  ON s.id_salon = hf.id_salon
             ORDER BY i.fecha DESC, i.hora DESC
             LIMIT ?`,
            [limite]
        );
        res.json({ success: true, incidencias: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Horario dinámico de hoy ──────────────────────────────────────────────
app.get('/api/horario/dinamico/hoy', async (req, res) => {
    const fecha = new Date().toISOString().split('T')[0];
    try {
        const [rows] = await pool.execute(
            `SELECT hd.id_horario_dinamico, hd.id_horario_fijo, hd.id_horario_fijo_detalle,
                    hd.fecha, hd.dia, hd.hora_inicio, hd.hora_fin, hd.bloque_horario,
                    hd.motivo_cambio, hd.id_salon_temporal,
                    st.nombre_salon AS salon_temporal_nombre,
                    h.id_grupo,
                    g.nombre_grupo
             FROM Horario_Dinamico hd
             INNER JOIN horarios h ON h.id_horario_fijo   = hd.id_horario_fijo
             INNER JOIN Grupos   g ON g.id_grupo           = h.id_grupo
             INNER JOIN Salones st ON st.id_salon          = hd.id_salon_temporal
             WHERE hd.fecha = ?
             ORDER BY hd.hora_inicio`,
            [fecha]
        );
        res.json({ success: true, dinamicos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Endpoints de favoritos ───────────────────────────────────────────

app.post('/api/favoritos/salon', async (req, res) => {
    const { boleta, id_salon } = req.body;
    if (!boleta || !id_salon) return res.status(400).json({ success: false, message: 'Faltan datos' });
    try {
        await pool.execute(
            `INSERT INTO Salones_Favoritos (id_usuario, id_salon, mostrar_inicio)
             VALUES (?, ?, TRUE)
             ON DUPLICATE KEY UPDATE fecha_agregado = CURRENT_TIMESTAMP`,
            [boleta, id_salon]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/favoritos/salon/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado, sf.mostrar_inicio
             FROM Salones_Favoritos sf
             INNER JOIN Salones s    ON s.id_salon       = sf.id_salon
             LEFT  JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE sf.id_usuario = ? ORDER BY sf.fecha_agregado DESC`,
            [req.params.boleta]
        );
        res.json({ success: true, favoritos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/favoritos/salon/:boleta/:id_salon', async (req, res) => {
    try {
        const [r] = await pool.execute(
            `DELETE FROM Salones_Favoritos WHERE id_usuario = ? AND id_salon = ?`,
            [req.params.boleta, req.params.id_salon]
        );
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/favoritos/salon/mostrar', async (req, res) => {
    const { boleta, id_salon, mostrar_inicio } = req.body;
    try {
        await pool.execute(
            `UPDATE Salones_Favoritos SET mostrar_inicio = ? WHERE id_usuario = ? AND id_salon = ?`,
            [mostrar_inicio, boleta, id_salon]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/favoritos/grupo', async (req, res) => {
    const { boleta, id_grupo } = req.body;
    if (!boleta || !id_grupo) return res.status(400).json({ success: false, message: 'Faltan datos' });
    try {
        await pool.execute(
            `INSERT INTO Grupos_Favoritos (id_usuario, id_grupo, mostrar_inicio)
             VALUES (?, ?, TRUE)
             ON DUPLICATE KEY UPDATE fecha_agregado = CURRENT_TIMESTAMP`,
            [boleta, id_grupo]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/favoritos/grupo/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT g.id_grupo, g.nombre_grupo, g.semestre, g.turno, gf.mostrar_inicio
             FROM Grupos_Favoritos gf
             INNER JOIN Grupos g ON g.id_grupo = gf.id_grupo
             WHERE gf.id_usuario = ? ORDER BY gf.fecha_agregado DESC`,
            [req.params.boleta]
        );
        res.json({ success: true, favoritos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/favoritos/grupo/:boleta/:id_grupo', async (req, res) => {
    try {
        const [r] = await pool.execute(
            `DELETE FROM Grupos_Favoritos WHERE id_usuario = ? AND id_grupo = ?`,
            [req.params.boleta, req.params.id_grupo]
        );
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/favoritos/grupo/mostrar', async (req, res) => {
    const { boleta, id_grupo, mostrar_inicio } = req.body;
    try {
        await pool.execute(
            `UPDATE Grupos_Favoritos SET mostrar_inicio = ? WHERE id_usuario = ? AND id_grupo = ?`,
            [mostrar_inicio, boleta, id_grupo]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/inicio/favoritos/:boleta', async (req, res) => {
    try {
        const [salones] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado, sf.mostrar_inicio
             FROM Salones_Favoritos sf
             INNER JOIN Salones s    ON s.id_salon       = sf.id_salon
             LEFT  JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE sf.id_usuario = ? AND sf.mostrar_inicio = TRUE
             ORDER BY sf.fecha_agregado LIMIT 4`,
            [req.params.boleta]
        );
        const [grupos] = await pool.execute(
            `SELECT g.id_grupo, g.nombre_grupo, g.semestre, g.turno, gf.mostrar_inicio
             FROM Grupos_Favoritos gf
             INNER JOIN Grupos g ON g.id_grupo = gf.id_grupo
             WHERE gf.id_usuario = ? AND gf.mostrar_inicio = TRUE
             ORDER BY gf.fecha_agregado LIMIT 4`,
            [req.params.boleta]
        );
        res.json({ success: true, salones, grupos });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── Crear horario fijo ───────────────────────────────────────────────────────
app.post('/api/horario/crear', async (req, res) => {
    const { id_grupo, id_materia, id_profesor, id_salon, dia, hora_inicio, hora_fin } = req.body;
    if (!id_grupo || !id_materia || !id_profesor || !dia || !hora_inicio || !hora_fin)
        return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });

    // Calcular bloque_horario a partir de hora_inicio (07:xx → bloque 1, 08:xx → 2, …)
    const hora = parseInt(hora_inicio.split(':')[0]);
    const bloquesBase = [7,8,9,10,11,12,13,14,15,16,17,18,19,20];
    const bloque_horario = bloquesBase.indexOf(hora) + 1;
    if (bloque_horario < 1)
        return res.status(400).json({ success: false, message: 'Hora de inicio no válida (rango 07:00–20:50)' });

    // id_salon es opcional (puede ser null si no aplica salon)
    const salonVal = (id_salon !== undefined && id_salon !== null && id_salon !== '') ? parseInt(id_salon) : null;

    try {
        // 1. Buscar si ya existe un registro en horarios para este grupo
        const [existing] = await pool.execute(
            `SELECT id_horario_fijo FROM horarios WHERE id_grupo = ? LIMIT 1`,
            [parseInt(id_grupo)]
        );

        let id_horario_fijo;
        if (existing.length > 0) {
            id_horario_fijo = existing[0].id_horario_fijo;
        } else {
            const [ins] = await pool.execute(
                `INSERT INTO horarios (id_grupo) VALUES (?)`,
                [parseInt(id_grupo)]
            );
            id_horario_fijo = ins.insertId;
        }

        // 2. Insertar el detalle en Horario_Fijo
        const [result] = await pool.execute(
            `INSERT INTO Horario_Fijo
               (id_horario_fijo, id_materia, id_profesor, id_salon, dia, hora_inicio, hora_fin, bloque_horario)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id_horario_fijo, parseInt(id_materia), parseInt(id_profesor),
             salonVal, dia, hora_inicio, hora_fin, bloque_horario]
        );

        res.json({ success: true, id: result.insertId, message: 'Horario registrado correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ─── Raíz ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', app: 'BDSM CECyT9 Web API', db: dbConfig.database });
});

// ─── Iniciar servidor ──────────────────────────────────────────────────────────
async function startServer() {
    const ok = await connectDB();
    if (!ok) {
        console.error('⚠ No se pudo conectar a la BD. El servidor arrancará de todos modos.');
        console.error('  Reintentando conexión en 10 segundos...');
        setTimeout(connectDB, 10000);
    }
    const server = app.listen(PORT, () => {
        console.log(`\nServidor corriendo en puerto ${PORT}`);
        console.log(`BD: ${dbConfig.database}\n`);
    });
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`\nEl puerto ${PORT} ya está en uso.`);
            console.error(`Abre el Administrador de tareas → busca "node.exe" → finaliza la tarea`);
            console.error(`O en PowerShell: Stop-Process -Name node -Force\n`);
        } else {
            console.error('Error del servidor:', e.message);
        }
        process.exit(1);
    });
}

startServer();


//Cocinadota poque me daba flojera :V