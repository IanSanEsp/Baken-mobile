const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');

const app  = express();
process.env.PORT = process.env.PORT || '3000';
const PORT = parseInt(process.env.PORT);

app.use(cors());
app.use(express.json());

const dbConfig = {
    host:           'yamabiko.proxy.rlwy.net',
    user:           'root',
    password:       'hdFfITZienJPkyyohBLiETNwDmRwSjgJ',
    database:       'railway',
    port:           28452,
    connectTimeout: 30000
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
        return false;
    }
}

// 1. Login de alumno
app.post('/api/login', async (req, res) => {
    const { correo, boleta } = req.body;
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo, u.turno,
                    tu.nombre_tipo AS tipo_usuario,
                    g.id_grupo, g.nombre_grupo AS grupo, g.semestre, g.turno AS grupo_turno
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT JOIN Grupos g ON g.id_grupo = u.id_grupo
             WHERE u.correo = ? AND u.id_usuarios = ? AND tu.nombre_tipo = 'Alumno'`,
            [correo, boleta]
        );
        if (rows.length === 0)
            return res.status(401).json({ success: false, message: 'Correo o boleta incorrectos' });

        const alumno = rows[0];
        res.json({
            success: true,
            message: 'Login exitoso',
            usuario: {
                id:       alumno.boleta,
                nombre:   alumno.nombre,
                correo:   alumno.correo,
                boleta:   alumno.boleta,
                grupo:    alumno.grupo || 'Sin grupo',
                id_grupo: alumno.id_grupo || null,
                semestre: alumno.semestre || 1,
                turno:    alumno.grupo_turno || 'No asignado'
            }
        });
    } catch (e) { res.status(500).json({ success: false, message: 'Error en el servidor' }); }
});

// 2. Info alumno por boleta
app.get('/api/alumno/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo, u.turno,
                    tu.nombre_tipo AS tipo_usuario,
                    g.nombre_grupo AS grupo, g.semestre, g.turno AS grupo_turno
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT JOIN Grupos g ON g.id_grupo = u.id_grupo
             WHERE u.id_usuarios = ?`,
            [req.params.boleta]
        );
        if (rows.length === 0)
            return res.status(404).json({ success: false, message: 'Alumno no encontrado' });
        res.json({ success: true, alumno: rows[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 3. Horario por id de grupo (POST)
app.post('/api/horario', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    m.nombre_materia AS materia,
                    u.nombre AS profesor_nombre,
                    s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS salon_tipo
             FROM Horario_Fijo hf
             INNER JOIN horarios h      ON h.id_horario_fijo   = hf.id_horario_fijo
             INNER JOIN Materias m      ON m.id_materia         = hf.id_materia
             INNER JOIN Profesores prof ON prof.id_profesor     = hf.id_profesor
             INNER JOIN Usuarios u      ON u.id_usuarios        = prof.id_profesor
             INNER JOIN Salones s       ON s.id_salon            = hf.id_salon
             LEFT  JOIN tipo_salon ts   ON ts.id_tipo_salon     = s.tipo_salon
             WHERE h.id_grupo = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes'), hf.hora_inicio`,
            [req.body.grupo]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 4. Salones por piso
app.get('/api/salones/piso/:piso', async (req, res) => {
    try {
        const pisoNum = req.params.piso === 'L' ? 0 : parseInt(req.params.piso);
        const [rows] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado
             FROM Salones s
             LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE s.piso = ? ORDER BY s.nombre_salon`,
            [pisoNum]
        );
        res.json({ success: true, salones: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 5. Todos los salones
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

// 6. Grupos por semestre y turno
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

// 7. Todos los profesores
app.get('/api/profesores', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo,
                    p.area_educacion AS materia, p.estado_asistencia
             FROM Usuarios u
             INNER JOIN Profesores p    ON p.id_profesor        = u.id_usuarios
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario   = u.tipo_usuario
             WHERE tu.nombre_tipo = 'Profesor' ORDER BY u.nombre`
        );
        res.json({ success: true, profesores: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 8. Estadísticas del plantel
app.get('/api/estadisticas', async (req, res) => {
    try {
        const [[grupos]]    = await pool.execute('SELECT COUNT(*) AS total FROM Grupos');
        const [[salones]]   = await pool.execute('SELECT COUNT(*) AS total FROM Salones');
        const [[profesores]]= await pool.execute('SELECT COUNT(*) AS total FROM Profesores');
        const [[alumnos]]   = await pool.execute(
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

// 9. Buscar salones con filtros
app.post('/api/salones/buscar', async (req, res) => {
    const { nombre, piso, disponibilidad, tipo } = req.body;
    try {
        let q = `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                        ts.nombre_tipo_salon AS tipo, s.estado
                 FROM Salones s LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon WHERE 1=1`;
        const p = [];
        if (nombre)                                    { q += ` AND s.nombre_salon LIKE ?`;       p.push(`%${nombre}%`); }
        if (piso !== undefined && piso !== '')         { q += ` AND s.piso = ?`;                  p.push(piso === 'L' ? 0 : parseInt(piso)); }
        if (disponibilidad && disponibilidad !== 'Todos') { q += ` AND s.estado = ?`;             p.push(disponibilidad); }
        if (tipo && tipo !== 'Todos')                  { q += ` AND ts.nombre_tipo_salon = ?`;    p.push(tipo); }
        q += ` ORDER BY s.piso, s.nombre_salon`;
        const [rows] = await pool.execute(q, p);
        res.json({ success: true, salones: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 10. Buscar grupos con filtros
app.post('/api/grupos/buscar', async (req, res) => {
    const { nombre, semestre, semestres, turno } = req.body;
    try {
        let q = `SELECT id_grupo, nombre_grupo, semestre, area_estudio, turno FROM Grupos WHERE 1=1`;
        const p = [];
        if (nombre) { q += ` AND nombre_grupo LIKE ?`; p.push(`%${nombre}%`); }
        // semestres (array) tiene prioridad sobre semestre (valor único) — retrocompatible
        if (Array.isArray(semestres) && semestres.length > 0) {
            q += ` AND semestre IN (${semestres.map(() => '?').join(',')})`;
            p.push(...semestres);
        } else if (semestre !== undefined && semestre !== '') {
            q += ` AND semestre = ?`;
            p.push(parseInt(semestre));
        }
        if (turno && turno !== 'Todos') { q += ` AND turno = ?`; p.push(turno); }
        q += ` ORDER BY semestre, nombre_grupo`;
        const [rows] = await pool.execute(q, p);
        res.json({ success: true, grupos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 11. Horario completo de grupo por ID (GET)
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
             INNER JOIN Salones    s   ON s.id_salon           = hf.id_salon
             WHERE hor.id_grupo = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes'), hf.hora_inicio`,
            [req.params.id_grupo]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 12. Horario de salón hoy
app.get('/api/horario/salon/:id_salon', async (req, res) => {
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const diaActual = dias[new Date().getDay()];
    try {
        const [rows] = await pool.execute(
            `SELECT hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    m.nombre_materia AS materia,
                    g.nombre_grupo,
                    u.nombre AS profesor_nombre
             FROM Horario_Fijo hf
             INNER JOIN horarios   h    ON h.id_horario_fijo  = hf.id_horario_fijo
             INNER JOIN Grupos     g    ON g.id_grupo          = h.id_grupo
             INNER JOIN Materias   m    ON m.id_materia        = hf.id_materia
             INNER JOIN Profesores prof ON prof.id_profesor    = hf.id_profesor
             INNER JOIN Usuarios   u    ON u.id_usuarios       = prof.id_profesor
             WHERE hf.id_salon = ? AND hf.dia = ?
             ORDER BY hf.hora_inicio`,
            [req.params.id_salon, diaActual]
        );
        res.json({ success: true, horario: rows, dia: diaActual });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 13. Guardar salón favorito
app.post('/api/favoritos/salon', async (req, res) => {
    const { boleta, id_salon } = req.body;
    if (!boleta || !id_salon)
        return res.status(400).json({ success: false, message: 'Faltan datos: boleta y id_salon' });
    try {
        await pool.execute(
            `INSERT INTO Salones_Favoritos (id_usuario, id_salon)
             VALUES (?, ?) ON DUPLICATE KEY UPDATE fecha_agregado = CURRENT_TIMESTAMP`,
            [boleta, id_salon]
        );
        res.json({ success: true, message: 'Salón guardado correctamente' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 14. Salones favoritos de un usuario
app.get('/api/favoritos/salon/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado, sf.mostrar_inicio
             FROM Salones_Favoritos sf
             INNER JOIN Salones s ON s.id_salon = sf.id_salon
             LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE sf.id_usuario = ? ORDER BY sf.fecha_agregado DESC`,
            [req.params.boleta]
        );
        res.json({ success: true, favoritos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 15. Eliminar salón favorito
app.delete('/api/favoritos/salon/:boleta/:id_salon', async (req, res) => {
    try {
        const [result] = await pool.execute(
            `DELETE FROM Salones_Favoritos WHERE id_usuario = ? AND id_salon = ?`,
            [req.params.boleta, req.params.id_salon]
        );
        if (result.affectedRows === 0)
            return res.status(404).json({ success: false, message: 'Favorito no encontrado' });
        res.json({ success: true, message: 'Salón eliminado de favoritos' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 16. Actualizar mostrar_inicio de salón favorito
app.put('/api/favoritos/salon/mostrar', async (req, res) => {
    const { boleta, id_salon, mostrar_inicio } = req.body;
    try {
        await pool.execute(
            `UPDATE Salones_Favoritos SET mostrar_inicio = ? WHERE id_usuario = ? AND id_salon = ?`,
            [mostrar_inicio, boleta, id_salon]
        );
        res.json({ success: true, message: 'Actualizado correctamente' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 17. Guardar grupo favorito
app.post('/api/favoritos/grupo', async (req, res) => {
    const { boleta, id_grupo } = req.body;
    if (!boleta || !id_grupo)
        return res.status(400).json({ success: false, message: 'Faltan datos: boleta y id_grupo' });
    try {
        await pool.execute(
            `INSERT INTO Grupos_Favoritos (id_usuario, id_grupo)
             VALUES (?, ?) ON DUPLICATE KEY UPDATE fecha_agregado = CURRENT_TIMESTAMP`,
            [boleta, id_grupo]
        );
        res.json({ success: true, message: 'Grupo guardado correctamente' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 18. Grupos favoritos de un usuario
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

// 19. Eliminar grupo favorito
app.delete('/api/favoritos/grupo/:boleta/:id_grupo', async (req, res) => {
    try {
        const [result] = await pool.execute(
            `DELETE FROM Grupos_Favoritos WHERE id_usuario = ? AND id_grupo = ?`,
            [req.params.boleta, req.params.id_grupo]
        );
        if (result.affectedRows === 0)
            return res.status(404).json({ success: false, message: 'Favorito no encontrado' });
        res.json({ success: true, message: 'Grupo eliminado de favoritos' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 20. Actualizar mostrar_inicio de grupo favorito
app.put('/api/favoritos/grupo/mostrar', async (req, res) => {
    const { boleta, id_grupo, mostrar_inicio } = req.body;
    try {
        await pool.execute(
            `UPDATE Grupos_Favoritos SET mostrar_inicio = ? WHERE id_usuario = ? AND id_grupo = ?`,
            [mostrar_inicio, boleta, id_grupo]
        );
        res.json({ success: true, message: 'Actualizado correctamente' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 21. Favoritos para pantalla de inicio
app.get('/api/inicio/favoritos/:boleta', async (req, res) => {
    try {
        const [salones] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, sf.mostrar_inicio
             FROM Salones_Favoritos sf
             INNER JOIN Salones s ON s.id_salon = sf.id_salon
             LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
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

// 22. Ruta raíz
app.get('/', (req, res) => {
    res.send('Servidor bDSm CECyT9 activo ✓');
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────
async function startServer() {
    const ok = await connectDB();
    if (!ok) { console.error('No se pudo conectar a MySQL'); process.exit(1); }
    app.listen(PORT, () => {
        console.log(`\nServidor corriendo en puerto ${PORT}`);
        console.log(`BD: ${dbConfig.host}:${dbConfig.port} → ${dbConfig.database}\n`);
    });
}

startServer();
